"""Riding-level vote counts for elections not covered by the historical
Atlas dataset (QC 2018/2022, federal 2025), parsed from the wikitext of
French Wikipedia's "Résultats détaillés des élections ..." companion
articles.

Rendered HTML tables for this content don't survive pandas.read_html
(colspan/rowspan on the party-color and majority cells breaks the column
alignment), so this parses the MediaWiki source directly: each riding is a
`==== Riding name ====` section containing one `{| class="wikitable...`
table with one row per candidate, in a stable pattern:
    |{{Couleur PPQ|PARTY_CODE}}|
    |align=left|[[Party full name]]
    |align=left|Candidate Name
    |{{formatnum:VOTES}}
    |PCT,WITH_COMMA
    |align=center|{{différence|...}}   (or {{abrd|Abs.|Absent}})
    |<small>{{formatnum:MAJORITY}}</small>   (first row only, rowspan)
"""

from __future__ import annotations

import re

import httpx
import pandas as pd

USER_AGENT = "polls-research-bot/0.1 (contact: yysrk9lh@duck.com; research project on Quebec poll aggregation)"
WIKI_API_URL = "https://fr.wikipedia.org/w/index.php"

RIDING_SECTION_RE = re.compile(
    r"==== ([^=\n]+?) ====\s*\n\{\|[^\n]*\n\|\+[^\n]*\n(.*?)\n\|\}", re.DOTALL
)
PARTY_CODE_RE = re.compile(r"\{\{Couleur PPQ\|([A-Za-z0-9]+)\}\}")
VOTES_RE = re.compile(r"\{\{formatnum:(\d+)\}\}")
PCT_LINE_RE = re.compile(r"^\|\s*(\d+,\d+)\s*$", re.MULTILINE)

# Wikipedia's colored-party-box template codes -> this project's party_code
# taxonomy (matching parties.party_code from the qc125 poll scrape), so
# election_results can be joined against poll_shares/parties directly.
PARTY_CODE_MAP = {
    "CAQ": "CAQ",
    "PLQ": "LIB",
    "QS": "QS",
    "PQ": "PQ",
    "PCQ2": "PCQ",
    "PCQ": "PCQ",
    "CON": "PCQ",  # Wikipedia's template code for the Parti conservateur du Québec is inconsistent across sections
}

# Region-level rollup sections use the same `==== X ====` + wikitable
# template as individual ridings; exclude them by name so they aren't
# ingested as fake ridings.
NON_RIDING_SECTION_RE = re.compile(r"r[ée]sum[ée]|total|ensemble du qu[ée]bec", re.IGNORECASE)


def fetch_wikitext(title: str, lang: str = "fr") -> str:
    resp = httpx.get(
        f"https://{lang}.wikipedia.org/w/index.php",
        params={"title": title, "action": "raw"},
        headers={"User-Agent": USER_AGENT},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.text


# Recent elections not covered by the Atlas historical archive. QC 2018/2022
# use the current 125-riding (2017) map, matching riding_demographics.
# Federal 2025 uses the current 343-riding (2023) map; federal 2021 predates
# that redistribution (338 ridings) so its riding_code values are on the
# OLD map and won't join cleanly against riding_demographics or the 2025
# results -- kept for party-level/aggregate backtesting only.
RECENT_ELECTIONS = [
    # 2014 is on the pre-2017 map, so its riding_code values don't join
    # against the 2017/2026 ones -- it's here to give a SECOND historical
    # transition for estimating how much riding-level swing varies
    # (model/swing_residuals.py), which one transition alone can't
    # establish. Matched by riding name where needed.
    {"kind": "qc", "title": "Résultats détaillés des élections générales québécoises de 2014", "date": "2014-04-07", "boundary_year": "2011"},
    {"kind": "qc", "title": "Résultats détaillés des élections générales québécoises de 2018", "date": "2018-10-01", "boundary_year": "2017"},
    {"kind": "qc", "title": "Résultats détaillés des élections générales québécoises de 2022", "date": "2022-10-03", "boundary_year": "2017"},
    {"kind": "federal", "title": "Results of the 2021 Canadian federal election by riding", "date": "2021-09-20", "boundary_year": "2013"},
    {"kind": "federal", "title": "Results of the 2025 Canadian federal election by riding", "date": "2025-04-28", "boundary_year": "2023"},
]


def fetch_all_recent_elections() -> pd.DataFrame:
    frames = []
    for spec in RECENT_ELECTIONS:
        if spec["kind"] == "qc":
            wikitext = fetch_wikitext(spec["title"], lang="fr")
            frames.append(parse_riding_results(wikitext, "qc-provincial", spec["date"], spec["boundary_year"]))
        else:
            wikitext = fetch_wikitext(spec["title"], lang="en")
            frames.append(parse_federal_riding_results(wikitext, spec["date"], spec["boundary_year"]))
    return pd.concat(frames, ignore_index=True)


def parse_riding_results(wikitext: str, jurisdiction_code: str, election_date: str, boundary_year: str) -> pd.DataFrame:
    rows = []
    for riding_match in RIDING_SECTION_RE.finditer(wikitext):
        riding_name, block = riding_match.group(1).strip(), riding_match.group(2)
        if NON_RIDING_SECTION_RE.search(riding_name):
            continue
        for row in block.split("|-"):
            party_m = PARTY_CODE_RE.search(row)
            votes_m = VOTES_RE.search(row)
            pct_m = PCT_LINE_RE.search(row)
            if not (party_m and votes_m):
                continue
            raw_code = party_m.group(1)
            party_code = PARTY_CODE_MAP.get(raw_code, f"AUTRES:{raw_code}")
            votes = int(votes_m.group(1))
            vote_share = float(pct_m.group(1).replace(",", ".")) / 100 if pct_m else None
            rows.append(
                {
                    "jurisdiction_code": jurisdiction_code,
                    "election_date": election_date,
                    "boundary_year": boundary_year,
                    "riding_code": riding_name,
                    "party_code": party_code,
                    "votes": votes,
                    "vote_share": vote_share,
                    "seat_won": None,
                }
            )
    df = pd.DataFrame(rows)
    if df.empty:
        return df
    # first row per riding/party in source order is the winner (Wikipedia
    # lists candidates in descending vote order within each riding table).
    df["seat_won"] = df.groupby("riding_code").cumcount() == 0
    return df


# --- Federal (English Wikipedia "Results of the ... by riding" pages) ---
#
# Different site, different template family: one riding per table ROW (not
# per subsection), with a `{{Canadian politics/candlist header|province=CA|
# Party1|Party2|...}}` line declaring the party column order for each
# region subsection (order varies by subsection, so it must be read fresh
# each time, not assumed global). Each party gets two consecutive cells
# (party-colour-if-winner, then "Name<br/>votes<br/>''pct%''"), followed by
# a final colour+name pair for the elected MP that this parser ignores in
# favour of computing the winner from max votes -- robust to that trailing
# column's exact shape, which isn't always present.

HEADER_RE = re.compile(r"\{\{Canadian politics/candlist header\|province=CA\|([^}]+)\}\}")
RIDING_ROW_RE = re.compile(r"\[\[([^\]|]+)")
CAND_CELL_RE = re.compile(r"<br\s*/?>\s*([\d,]+)\s*<br\s*/?>\s*''\[?\[?([\d.]+)%")

FEDERAL_PARTY_MAP = {
    "Liberal": "LPC",
    "Conservative": "CPC",
    "NDP": "NDP",
    "Green": "GPC",
    "BQ": "BQ",
}


def parse_federal_riding_results(wikitext: str, election_date: str, boundary_year: str) -> pd.DataFrame:
    rows = []
    current_parties: list[str] | None = None
    lines = wikitext.split("\n")
    i = 0
    while i < len(lines):
        line = lines[i]
        header_m = HEADER_RE.search(line)
        if header_m:
            current_parties = [p.strip() for p in header_m.group(1).split("|")]
            i += 1
            continue

        if current_parties and line.startswith("|") and "[[" in line and "style=" in line:
            riding_m = RIDING_ROW_RE.search(line)
            riding_name = riding_m.group(1).strip() if riding_m else None

            cell_lines = []
            j = i + 1
            while j < len(lines) and not lines[j].startswith("|-") and not lines[j].startswith("=") and not HEADER_RE.search(lines[j]):
                if lines[j].startswith("|"):
                    cell_lines.append(lines[j])
                j += 1

            if riding_name:
                for idx, party in enumerate(current_parties):
                    cell_pos = idx * 2 + 1  # skip the colour cell, land on the candidate cell
                    if cell_pos >= len(cell_lines):
                        continue
                    cand_m = CAND_CELL_RE.search(cell_lines[cell_pos])
                    if not cand_m:
                        continue
                    votes = int(cand_m.group(1).replace(",", ""))
                    pct = float(cand_m.group(2)) / 100
                    party_code = FEDERAL_PARTY_MAP.get(party, f"AUTRES:{party}")
                    rows.append(
                        {
                            "jurisdiction_code": "ca-federal",
                            "election_date": election_date,
                            "boundary_year": boundary_year,
                            "riding_code": riding_name,
                            "party_code": party_code,
                            "votes": votes,
                            "vote_share": pct,
                            "seat_won": None,
                        }
                    )
            i = j
            continue
        i += 1

    df = pd.DataFrame(rows)
    if df.empty:
        return df
    df = df.sort_values("votes", ascending=False)
    df["seat_won"] = ~df.duplicated(subset=["riding_code"], keep="first") & (
        df.groupby("riding_code")["votes"].transform("max") == df["votes"]
    )
    return df.sort_values(["riding_code", "votes"], ascending=[True, False]).reset_index(drop=True)
