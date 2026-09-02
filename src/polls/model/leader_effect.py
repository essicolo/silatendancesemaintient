"""Leader effect estimated across 1970-2022, with its time variation shown.

Replaces the two-anecdote estimate (PSPP 2022 +0.76, Couillard 2014 +0.36).
Every same-map consecutive election pair since 1970 contributes cases, each
classified by what the leader's presence on the local ballot CHANGED:

  - arrivee: the leader contests a riding they did not contest at the
    previous election ("parachute") -- the effect the projection needs for
    Fréchette/Trois-Rivières, Milliard/Orford, Duhaime/Bellechasse;
  - continuation: same person, same riding, was already leader -- a control
    group whose excess should be near zero, since their personal vote is in
    the baseline;
  - depart: the previous election's leader is not on this riding's ballot
    any more -- the symmetric penalty.

The excess is measured against the uniform-ILR-swing counterfactual, the
same machinery the projection itself uses. Cases whose counterfactual is
broken -- the party polled under 4% provincially at the base election, where
multiplicative swing explodes (Duhaime/Chauveau 2022: predicted 48% from an
8.6% base) -- are excluded on that stated criterion.

Effects are not assumed stable over fifty years. The output lists every case
chronologically, splits the means by era, and the APPLIED value is a
recency-weighted mean (half-life RECENCY_HALF_LIFE_YEARS), so the 1970s
inform the estimate without dominating it.
"""

from __future__ import annotations

import json
import re
import unicodedata
from pathlib import Path

import duckdb
import numpy as np
import nuee
import pandas as pd

from polls.ingest.historical_leaders import ELECTIONS, build, candidacies

RAW_CACHE = Path(__file__).parents[3] / "data" / "raw" / "historical_leaders.json"
OUT_PATH = Path(__file__).parents[3] / "js" / "data" / "qc_leader_effect.json"
MIN_BASE_SHARE = 0.04
TARGET_YEAR = 2026

# Ridings renamed between two elections on the same map. Without this the
# name intersection silently drops the case -- which cost the single largest
# modern arrival (PSPP in Camille-Laurin, née Bourget until 2019).
RIDING_RENAMES = {
    "bourget": "camillelaurin",
}

# Atlas-era party-column names -> project codes.
ATLAS_CODES = {
    "Parti_quebecois": "PQ", "Parti_liberal": "LIB", "Union_nationale": "UN",
    "Coalition_avenir_quebec": "CAQ", "Quebec_solidaire": "QS",
    "Action_democratique": "ADQ", "Ralliement_creditiste": "RC",
    "Autres_parti_conservateur": "PCQ",
}
CODES = ["LIB", "PQ", "UN", "RC", "ADQ", "CAQ", "QS", "PCQ"]


def _norm_party(code: str) -> str:
    return ATLAS_CODES.get(code, code if code in CODES else "AUTRES")


def _alnum(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", unicodedata.normalize("NFKD", str(text)).encode("ascii", "ignore").decode().lower())


def leaders_table(con) -> pd.DataFrame:
    if RAW_CACHE.exists():
        return pd.DataFrame(json.loads(RAW_CACHE.read_text(encoding="utf-8")))
    df = build(con)
    RAW_CACHE.write_text(json.dumps(df.to_dict("records"), ensure_ascii=False, indent=1), encoding="utf-8")
    return df


def shares_matrix(con, election: str) -> pd.DataFrame:
    df = con.execute(
        "SELECT riding_code, party_code, sum(votes) v FROM election_results "
        "WHERE jurisdiction_code='qc-provincial' AND election_date=? GROUP BY 1,2",
        [election],
    ).df()
    df["party_code"] = df["party_code"].map(_norm_party)
    wide = df.pivot_table(index="riding_code", columns="party_code", values="v", aggfunc="sum")
    parties = [p for p in CODES if p in wide.columns] + (["AUTRES"] if "AUTRES" in wide.columns else [])
    wide = wide.reindex(columns=parties).fillna(0.0)
    return wide.div(wide.sum(axis=1), axis=0)


def _ilr(x):
    return nuee.ilr(nuee.closure(nuee.multiplicative_replacement(np.asarray(x, dtype=float), (1 / x.shape[1]) ** 2)))


def pair_excess(con, e_a: str, e_b: str):
    """Predicted-vs-actual per riding for the pair, on the shared party set.
    Returns None when the two elections don't share a map (name overlap)."""
    a, b = shares_matrix(con, e_a), shares_matrix(con, e_b)
    # Index on alphanumeric keys with renames applied BEFORE intersecting --
    # a riding renamed between the two elections must still pair.
    for df in (a, b):
        df.index = [RIDING_RENAMES.get(_alnum(r), _alnum(r)) for r in df.index]
    a, b = a[~a.index.duplicated()], b[~b.index.duplicated()]
    common_r = a.index.intersection(b.index)
    if len(common_r) < 100:
        return None
    common_p = [p for p in a.columns if p in b.columns]
    A = a.loc[common_r, common_p]
    B = b.loc[common_r, common_p]
    A = A.div(A.sum(axis=1), axis=0)
    B = B.div(B.sum(axis=1), axis=0)

    tot_a = A.mul(0).add(1)  # placeholder to keep shape; provincial from vote sums:
    prov_a = con.execute(
        "SELECT party_code, sum(votes) v FROM election_results WHERE jurisdiction_code='qc-provincial' AND election_date=? GROUP BY 1",
        [e_a],
    ).df()
    prov_b = con.execute(
        "SELECT party_code, sum(votes) v FROM election_results WHERE jurisdiction_code='qc-provincial' AND election_date=? GROUP BY 1",
        [e_b],
    ).df()

    def close(df):
        df = df.copy()
        df["party_code"] = df["party_code"].map(_norm_party)
        s = df.groupby("party_code")["v"].sum().reindex(common_p).fillna(0)
        return (s / s.sum()).to_numpy()

    pa, pb = close(prov_a), close(prov_b)
    delta = _ilr(pb.reshape(1, -1))[0] - _ilr(pa.reshape(1, -1))[0]
    pred = nuee.ilr_inv(_ilr(A.to_numpy()) + delta)
    return {
        "ridings": list(common_r), "parties": common_p,
        "base": A, "actual": B, "pred": pd.DataFrame(pred, index=common_r, columns=common_p),
        "prov_base": dict(zip(common_p, pa)),
    }


def classify_cases(con, leaders: pd.DataFrame) -> pd.DataFrame:
    rows = []
    ok = leaders[leaders["status"] == "ok"]
    riding_by = {(r.election_date, r.party_code): r.riding_name for r in ok.itertuples()}
    leader_by = {(r.election_date, r.party_code): r.leader_name for r in ok.itertuples()}

    for e_a, e_b in zip(ELECTIONS[:-1], ELECTIONS[1:]):
        pair = pair_excess(con, e_a, e_b)
        if pair is None:
            continue
        year_a, year_b = int(e_a[:4]), int(e_b[:4])

        def person_riding(name: str, year: int) -> str | None:
            for person in re.split(r"\s+et\s+", name):
                cands = candidacies(person.strip())
                if cands and year in cands:
                    return cands[year]
            return None

        def excess_for(riding: str, party: str) -> float | None:
            key = RIDING_RENAMES.get(_alnum(riding), _alnum(riding))
            if key not in pair["ridings"] or party not in pair["parties"]:
                return None
            if pair["prov_base"].get(party, 0) < MIN_BASE_SHARE:
                return None  # broken multiplicative counterfactual
            actual = pair["actual"].loc[key, party]
            pred = pair["pred"].loc[key, party]
            if actual <= 0 or pred <= 0:
                return None
            return float(np.log(actual / pred))

        # Arrivals & continuations: leaders at B.
        for (ed, party), riding in riding_by.items():
            if ed != e_b:
                continue
            name = leader_by[(ed, party)]
            prev = person_riding(name, year_a)
            kind = "continuation" if prev and _alnum(prev) == _alnum(riding) else "arrivee"
            exc = excess_for(riding, party)
            if exc is not None:
                rows.append({"annee": year_b, "personne": name, "parti": party, "circonscription": riding,
                             "type": kind, "exces_log": exc})

        # Departures: leaders at A whose person is no longer on that riding's
        # ballot at B.
        for (ed, party), riding in riding_by.items():
            if ed != e_a:
                continue
            name = leader_by[(ed, party)]
            still = person_riding(name, year_b)
            if still and _alnum(still) == _alnum(riding):
                continue
            exc = excess_for(riding, party)
            if exc is not None:
                rows.append({"annee": year_b, "personne": name, "parti": party, "circonscription": riding,
                             "type": "depart", "exces_log": exc})

    return pd.DataFrame(rows).sort_values(["type", "annee"]).reset_index(drop=True)


def fit_time_trend(cases: pd.DataFrame) -> dict:
    """One GP per case type over STANDARDIZED YEAR, extrapolated to
    TARGET_YEAR. A continuous year covariate, not era buckets: it keeps the
    estimation in one multivariate frame and gives a principled
    extrapolation to 2026 with uncertainty that grows past the last
    observation -- exactly what era splits and recency weights fake badly.
    """
    from sklearn.gaussian_process import GaussianProcessRegressor
    from sklearn.gaussian_process.kernels import ConstantKernel, Matern, WhiteKernel

    out = {}
    mu, sd = cases["annee"].mean(), cases["annee"].std()
    for kind, grp in cases.groupby("type"):
        x = ((grp["annee"] - mu) / sd).to_numpy().reshape(-1, 1)
        y = grp["exces_log"].to_numpy()
        gp = GaussianProcessRegressor(
            kernel=ConstantKernel() * Matern(length_scale=1.0, nu=1.5) + WhiteKernel(),
            normalize_y=True, n_restarts_optimizer=4, random_state=0,
        ).fit(x, y)
        xt = np.array([[(TARGET_YEAR - mu) / sd]])
        mean, std = gp.predict(xt, return_std=True)
        out[kind] = {"n": int(len(grp)), "delta_2026": float(mean[0]), "sd_2026": float(std[0]),
                     "flat_mean": float(y.mean())}
    return out


def main() -> None:
    con = duckdb.connect(str(Path(__file__).parents[3] / "data" / "polls.duckdb"), read_only=True)
    leaders = leaders_table(con)
    cases = classify_cases(con, leaders)
    con.close()

    pd.set_option("display.width", 200)
    print(cases.to_string(index=False))

    trend = fit_time_trend(cases)
    print("\n=== GP sur annee centree-reduite, prediction 2026 ===")
    for kind, t in trend.items():
        print(f"{kind:13s} n={t['n']:2d}  moyenne plate={t['flat_mean']:+.3f}  "
              f"delta(2026)={t['delta_2026']:+.3f}  sd={t['sd_2026']:.3f}  facteur={np.exp(t['delta_2026']):.3f}")

    OUT_PATH.write_text(json.dumps({
        "target_year": TARGET_YEAR,
        "effects": trend,
        "note": "exces log vs contrefactuel de swing uniforme ILR; GP Matern sur annee centree-reduite",
    }, indent=2), encoding="utf-8")
    print(f"\n-> {OUT_PATH}")


if __name__ == "__main__":
    main()
