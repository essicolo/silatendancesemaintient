"""How much of a poll-measured regional deviation shows up in the result?

The dashboard's uniform swing preserves each riding's 2022 regional
structure. Léger's regional breakdowns measure the CURRENT structure, and
they disagree with the preserved one (PCQ 30 vs 23 in the Quebec City
region). Before feeding that in, this calibrates the one question that
matters: when the polls said a region had moved relative to the province,
how much of that movement was real?

Design, on the 2022 cycle (the one election with both regional polls and a
result in hand):

    predicted change = dev_polls_2022 - dev_actual_2018
    realized  change = dev_actual_2022 - dev_actual_2018

where dev_X = ilr(region shares) - ilr(province shares), computed per region
(MTL RMR / Capitale-Nationale / reste du Québec) over the shared major-party
set. The slope of realized on predicted, through the origin, is the shrinkage
lambda the dashboard applies to today's Léger-measured gaps. lambda = 1 means
regional polls are taken at face value; 0 means ignored.

Regional polls come from the 2022 cycle page's own breakdown tables -- the
ones wiki_polls.py deliberately EXCLUDES from the national series. Exclusion
there and use here are the same decision seen from two sides: they are not
province-wide observations, they are regional ones.

Region-definition caveat, stated: the poll tables use RMR Montréal /
Capitale-Nationale; our riding map uses the CMA-based MTL/QC classification.
Close but not identical, and the calibration inherits that blur.
"""

from __future__ import annotations

from pathlib import Path

import duckdb
import numpy as np
import nuee
import pandas as pd

from polls.ingest.wiki_polls import PARTY_COLUMNS, _cell_text, _parse_date, _parse_number, _tables_with_headings, fetch_page

PARTIES = ["CAQ", "LIB", "QS", "PQ", "PCQ"]
REGION_HEADINGS = {
    "MTL": "region metropolitaine de montreal",
    "QC": "capitale-nationale",
    "REG": "reste du quebec",
}
FINAL_WINDOW_DAYS = 35


def _strip(text: str) -> str:
    import re, unicodedata

    return re.sub(r"\s+", " ", unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()).strip().lower()


def regional_final_polls(cycle_page: str, election: pd.Timestamp) -> tuple[dict[str, np.ndarray], pd.Timestamp | None]:
    """Average share vector per region over the last FINAL_WINDOW_DAYS of
    regional data AVAILABLE -- anchored on the latest regional row, not on
    election day: the 2022 regional breakdowns stop in late August, weeks
    before the vote, and an election-day-anchored window returns nothing.
    Also returns the anchor date so the national comparison can use the SAME
    period (comparing August regionals to September nationals would fold the
    campaign's national movement into the regional deviations)."""
    snapshot = fetch_page(cycle_page)
    import lxml.html

    doc = lxml.html.fromstring(snapshot.html)
    dated: list[tuple[str, pd.Timestamp, np.ndarray]] = []

    for table, headings in _tables_with_headings(doc):
        joined = _strip(" / ".join(headings))
        region = next((code for code, pat in REGION_HEADINGS.items() if pat in joined), None)
        if region is None:
            continue
        headers = [_cell_text(th) for th in table.xpath(".//tr[1]/th")]
        if "Sondeur" not in headers or "CAQ" not in headers:
            continue
        idx = {h: i for i, h in enumerate(headers)}
        for tr in table.xpath(".//tr"):
            cells = tr.xpath("./td")
            if len(cells) < len(headers) - 2:
                continue
            d = _parse_date(_cell_text(cells[0]))
            if d is None or pd.Timestamp(d) > election:
                continue
            shares = {}
            for col, i in idx.items():
                if col in PARTY_COLUMNS and PARTY_COLUMNS[col] in PARTIES and i < len(cells):
                    v = _parse_number(_cell_text(cells[i]))
                    if v is not None:
                        shares[PARTY_COLUMNS[col]] = v
            if len(shares) >= 4:
                dated.append((region, pd.Timestamp(d), np.array([shares.get(p, np.nan) for p in PARTIES])))

    if not dated:
        return {}, None
    anchor = max(d for _, d, _ in dated)
    window = [(r, v) for r, d, v in dated if d >= anchor - pd.Timedelta(days=FINAL_WINDOW_DAYS)]
    out: dict[str, list[np.ndarray]] = {}
    for r, v in window:
        out.setdefault(r, []).append(v)
    return {r: np.nanmean(np.vstack(v), axis=0) for r, v in out.items() if v}, anchor


def actual_regional_shares(con, election: str) -> dict[str, np.ndarray]:
    regions = pd.read_json(Path(__file__).parents[3] / "js" / "data" / "qc_riding_regions.json")
    reg_by_code = dict(zip(regions["riding_code"].astype(str), regions["region_code"]))
    df = con.execute(
        "SELECT riding_code, party_code, sum(votes) v FROM election_results "
        "WHERE jurisdiction_code='qc-provincial' AND election_date=? AND boundary_year='2026' GROUP BY 1,2",
        [election],
    ).df()
    df["riding_code"] = df["riding_code"].astype(str).map(lambda c: str(int(float(c))) if c.replace(".", "").isdigit() else c)
    df["region"] = df["riding_code"].map(reg_by_code)
    df = df[df["party_code"].isin(PARTIES) & df["region"].notna()]
    out = {}
    for region, grp in df.groupby("region"):
        s = grp.groupby("party_code")["v"].sum().reindex(PARTIES).fillna(0)
        out[region] = (s / s.sum()).to_numpy()
    return out


def _ilr(v: np.ndarray) -> np.ndarray:
    return nuee.ilr(nuee.closure(nuee.multiplicative_replacement(v.reshape(1, -1), (1 / len(v)) ** 2)))[0]


def main() -> None:
    con = duckdb.connect(str(Path(__file__).parents[3] / "data" / "polls.duckdb"), read_only=True)
    election = pd.Timestamp("2022-10-03")

    polls, anchor = regional_final_polls("Liste de sondages sur les élections générales québécoises de 2022", election)
    print(f"ancre des sondages regionaux : {anchor.date()} (fenetre {FINAL_WINDOW_DAYS} j en amont)")
    act22 = actual_regional_shares(con, "2022-10-03")
    act18 = actual_regional_shares(con, "2018-10-01")

    prov22 = np.sum([v for v in act22.values()], axis=0)  # not vote-weighted exactly; close enough for devs
    # province from full vote sums instead:
    prov = {}
    for e, tgt in (("2022-10-03", "22"), ("2018-10-01", "18")):
        df = con.execute(
            "SELECT party_code, sum(votes) v FROM election_results WHERE jurisdiction_code='qc-provincial' "
            "AND election_date=? AND boundary_year='2026' AND party_code IN ('CAQ','LIB','QS','PQ','PCQ') GROUP BY 1",
            [e],
        ).df().set_index("party_code")["v"].reindex(PARTIES).fillna(0)
        prov[tgt] = (df / df.sum()).to_numpy()

    # National anchor over the SAME window as the regional rows.
    lo, hi = (anchor - pd.Timedelta(days=FINAL_WINDOW_DAYS)).date(), anchor.date()
    poll_nat = con.execute(
        """SELECT s.party_code, avg(s.pct_reported) m FROM polls p JOIN poll_shares s USING (poll_id)
        WHERE p.jurisdiction_code='qc-provincial' AND p.region_code='National'
        AND p.poll_date BETWEEN ? AND ? AND s.party_code IN ('CAQ','LIB','QS','PQ','PCQ')
        GROUP BY 1""", [str(lo), str(hi)],
    ).df().set_index("party_code")["m"].reindex(PARTIES).to_numpy()

    xs, ys = [], []
    print("region  coord   predit   realise")
    for region in ["MTL", "QC", "REG"]:
        if region not in polls:
            print(f"  {region}: pas de sondages regionaux extraits")
            continue
        dev_poll = _ilr(polls[region]) - _ilr(poll_nat)
        dev_a22 = _ilr(act22[region]) - _ilr(prov["22"])
        dev_a18 = _ilr(act18[region]) - _ilr(prov["18"])
        pred = dev_poll - dev_a18
        real = dev_a22 - dev_a18
        for j in range(len(pred)):
            xs.append(pred[j]); ys.append(real[j])
            print(f"  {region}   ilr{j}   {pred[j]:+.3f}   {real[j]:+.3f}")

    xs, ys = np.array(xs), np.array(ys)
    lam = float(xs @ ys / (xs @ xs))
    resid = ys - lam * xs
    r2 = 1 - float(resid @ resid) / float(ys @ ys)
    print(f"\nlambda (pente par l'origine) = {lam:.3f}   R2 = {r2:.3f}   n = {len(xs)}")

    import json
    out = Path(__file__).parents[3] / "js" / "data" / "qc_regional_calibration.json"
    out.write_text(json.dumps({"lambda": lam, "r2": r2, "n": int(len(xs)),
                               "note": "realise ~ lambda * predit, devs ILR regionaux 2022, fenetre finale 35 j"}, indent=2),
                   encoding="utf-8")
    print(f"-> {out}")


if __name__ == "__main__":
    main()
