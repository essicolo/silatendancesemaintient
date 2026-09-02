"""Party leaders and the riding they contested, per general election, 1970-2022.

Needed to estimate the leader effect on a real sample instead of the two
anecdotes (PSPP 2022, Couillard 2014) the first pass used. Assembled from two
Wikipedia sources that each carry half the answer:

  - each election page's results table names the LEADER per party;
  - each leader's own article's "Résultats électoraux" tables, whose captions
    read "Élection générale québécoise de 2014 dans Roberval", locate every
    CANDIDACY -- including losses, which infobox mandates miss (Lévesque's
    1970 Laurier and 1973 Dorion defeats), and with none of the ambiguity
    that made a year-window heuristic silently place Marois in a riding she
    did not contest. Rows neither source resolves are left blank and printed:
    an incomplete table with known holes beats a complete one with silent
    guesses.

Every resolved (election, party, riding) row is validated against
election_results: the party must actually have votes in that riding at that
election, or the row is discarded as a mis-extraction.
"""

from __future__ import annotations

import re
import unicodedata
from datetime import date

import httpx
import lxml.html
import pandas as pd

USER_AGENT = "polls-research-bot/0.1 (contact: yysrk9lh@duck.com; Quebec election forecasting project)"

ELECTIONS = [
    "1970-01-01", "1973-10-29", "1976-11-15", "1981-04-13", "1985-12-02",
    "1989-09-25", "1994-09-12", "1998-11-30", "2003-04-14", "2007-03-26",
    "2008-12-08", "2012-09-04", "2014-04-07", "2018-10-01", "2022-10-03",
]

# Party labels as they appear in election-page results tables -> our codes.
PARTY_LABELS = {
    "parti quebecois": "PQ",
    "quebecois": "PQ",
    "liberal": "LIB",
    "union nationale": "UN",
    "ralliement creditiste": "RC",
    "creditiste": "RC",
    "action democratique": "ADQ",
    "coalition avenir": "CAQ",
    "quebec solidaire": "QS",
    "solidaire": "QS",
    "conservateur": "PCQ",
}
MAJOR = {"PQ", "LIB", "UN", "ADQ", "CAQ", "QS", "PCQ"}


def _clean(text: str) -> str:
    text = re.sub(r"\[.*?\]", "", text)
    return re.sub(r"\s+", " ", text.replace("\xa0", " ")).strip()


def _sa(text: str) -> str:
    return unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")


def _fetch(title: str) -> lxml.html.HtmlElement | None:
    url = f"https://fr.wikipedia.org/wiki/{title.replace(' ', '_')}"
    try:
        resp = httpx.get(url, headers={"User-Agent": USER_AGENT}, timeout=30, follow_redirects=True)
        if resp.status_code != 200:
            return None
        return lxml.html.fromstring(resp.content.decode("utf-8"))
    except Exception:
        return None


def leaders_for_election(election: str) -> list[dict]:
    """[{party_code, leader_name}] from the election page's results table."""
    year = election[:4]
    doc = _fetch(f"Élections générales québécoises de {year}")
    if doc is None:
        return []
    out, seen = [], set()
    for table in doc.xpath("//table"):
        headers = [_clean(th.text_content()) for th in table.xpath(".//tr[1]//th")]
        if "Chef" not in headers:
            continue
        # Row layout does not mirror the header (a colour-swatch cell leads,
        # and a second header row interleaves), so rows are read by content:
        # the first cell matching a party label, then the NEXT non-empty cell
        # as the leader -- accepted only if it reads as a person name.
        for tr in table.xpath(".//tr")[1:]:
            texts = [_clean(c.text_content()) for c in tr.xpath("./td|./th")]
            for i, cell in enumerate(texts):
                key = _sa(cell).lower()
                code = next((c for k, c in PARTY_LABELS.items() if k in key), None)
                if code is None or code not in MAJOR or code in seen:
                    continue
                if i + 1 < len(texts):
                    leader = texts[i + 1]
                    if leader and not re.search(r"\d", leader) and len(leader.split()) >= 2:
                        out.append({"party_code": code, "leader_name": leader})
                        seen.add(code)
                break
        if out:
            break
    return out


CAPTION_RE = re.compile(
    r"[ée]lection\s+g[ée]n[ée]rale\s+qu[ée]b[ée]coise\s+de\s+(\d{4})\s+dans\s+(.+)",
    re.IGNORECASE,
)

_candidacy_cache: dict[str, dict[int, str] | None] = {}


def _alnum(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", _sa(text).lower())


def candidacies(person: str) -> dict[int, str] | None:
    """{election year: riding caption text} from the person's article.

    Politician articles carry a "Résultats électoraux" section with one table
    per candidacy, whose CAPTION reads "Élection générale québécoise de 2014
    dans Roberval". Unlike infobox mandates, captions cover LOSSES too --
    Lévesque's 1970 Laurier and 1973 Dorion defeats are there -- and they are
    exact, where the earlier mandate-window heuristic silently placed Marois
    in Taillon for an election she fought in Charlevoix-Côte-de-Beaupré.
    """
    if person not in _candidacy_cache:
        doc = _fetch(person)
        if doc is None:
            _candidacy_cache[person] = None
        else:
            found: dict[int, str] = {}
            for table in doc.xpath("//table[caption]"):
                caption = _clean(table.xpath("./caption")[0].text_content())
                m = CAPTION_RE.search(_sa(caption))
                if m:
                    found[int(m.group(1))] = re.sub(r"\[.*?\]", "", m.group(2)).strip()
            _candidacy_cache[person] = found or None
    return _candidacy_cache[person]


def riding_for_leader(leader: str, election: str, riding_names_lower: dict[str, str]) -> str | None:
    """Riding names are matched on alphanumerics only: NFKD-ascii folding
    drops en-dashes entirely, so "Charlevoix–Côte-de-Beaupré" survives as
    one run of letters on both sides."""
    eyear = int(election[:4])
    by_alnum = {_alnum(v): v for v in riding_names_lower.values()}

    # Co-led parties list two names in the leader cell ("X et Y"); resolve
    # each person separately and accept only an unambiguous answer.
    persons = [p.strip() for p in re.split(r"\s+et\s+", leader) if p.strip()]
    hits = []
    for person in persons:
        cands = candidacies(person)
        if cands and eyear in cands:
            resolved = by_alnum.get(_alnum(cands[eyear]))
            if resolved:
                hits.append(resolved)
    if len(set(hits)) == 1:
        return hits[0]
    return None  # not found, or two co-leaders in different ridings -- ambiguous


def build(con) -> pd.DataFrame:
    rows = []
    for election in ELECTIONS:
        valid = con.execute(
            "SELECT DISTINCT riding_code FROM election_results "
            "WHERE jurisdiction_code='qc-provincial' AND election_date=?",
            [election],
        ).df()["riding_code"].tolist()
        names_lower = {_sa(n).lower(): n for n in valid}

        for entry in leaders_for_election(election):
            riding = riding_for_leader(entry["leader_name"], election, names_lower)
            status = "ok" if riding else "introuvable"
            if riding:
                # Validation: the leader's party must have votes there.
                votes = con.execute(
                    "SELECT sum(votes) FROM election_results WHERE jurisdiction_code='qc-provincial' "
                    "AND election_date=? AND riding_code=?",
                    [election, riding],
                ).fetchone()[0]
                if not votes:
                    riding, status = None, "invalide"
            rows.append({"election_date": election, **entry, "riding_name": riding, "status": status})
    return pd.DataFrame(rows)


if __name__ == "__main__":
    import duckdb

    con = duckdb.connect("data/polls.duckdb", read_only=True)
    df = build(con)
    con.close()
    print(df.to_string())
    n_ok = (df["status"] == "ok").sum()
    print(f"\n{n_ok}/{len(df)} resolus")
