"""Historical general-election results (Quebec provincial + federal-in-Quebec,
1867-2012/2011), from the "Atlas des élections au Québec" open dataset
(Fondation Lionel-Groulx, via Données Québec).

This is the deep backbone for backtesting and for long-run compositional
analysis (house effects, regional drift), NOT the source for riding-level
swing-model baselines: ridings are identified by NAME in this dataset, and
those names/boundaries have been redrawn repeatedly since 1867. They do not
line up with the current riding_code used in riding_demographics/polls
(2017 boundaries for provincial, 2023 for federal) except loosely for recent
elections. A name-based crosswalk for the most recent maps could close that
gap later; until then, treat riding_code here as a historical label, not a
join key against the other tables.

Column layout differs release to release (demographic/turnout columns vary
by era), so parties are identified generically: any column that isn't in
the known metadata set is a party/candidate vote-count column.
"""

from __future__ import annotations

import re

import duckdb
import httpx
import pandas as pd

USER_AGENT = "polls-research-bot/0.1 (contact: yysrk9lh@duck.com)"
CKAN_PACKAGE_URL = "https://www.donneesquebec.ca/recherche/api/3/action/package_show"
ATLAS_PACKAGE_ID = "atlas-des-elections-au-quebec"

METADATA_COL_PREFIXES = (
    "circonscriptions",
    "anglophones",
    "francophones",
    "allophones",
    "electeurs",
    "votes_exprimes",
    "votes_valides",
    "bulletins",
    "abstentions",
    "population_totale",
    "canadiens_francais",
)

# Exact dates confirmed from electionsquebec.qc.ca's own results listing.
# Elections not listed here (mostly pre-1970) get a Jan-1-of-year placeholder
# date -- the source Atlas files only carry the year, and no verified exact
# date for those was sourced for this project. Treat those as year-accurate
# only, not day-accurate.
QC_CONFIRMED_DATES = {
    1973: "1973-10-29",
    1976: "1976-11-15",
    1981: "1981-04-13",
    1985: "1985-12-02",
    1989: "1989-09-25",
    1994: "1994-09-12",
    1998: "1998-11-30",
    2003: "2003-04-14",
    2007: "2007-03-26",
    2008: "2008-12-08",
    2012: "2012-09-04",
    2014: "2014-04-07",
    2018: "2018-10-01",
    2022: "2022-10-03",
}


def list_atlas_resources() -> list[dict]:
    resp = httpx.get(CKAN_PACKAGE_URL, params={"id": ATLAS_PACKAGE_ID}, headers={"User-Agent": USER_AGENT}, timeout=30)
    resp.raise_for_status()
    return resp.json()["result"]["resources"]


def _election_date(jurisdiction_code: str, year: int) -> str:
    if jurisdiction_code == "qc-provincial" and year in QC_CONFIRMED_DATES:
        return QC_CONFIRMED_DATES[year]
    return f"{year}-01-01"


def _is_metadata_col(col: str) -> bool:
    lowered = col.lower()
    return any(lowered.startswith(p) for p in METADATA_COL_PREFIXES)


def parse_election_csv(content: bytes, jurisdiction_code: str, year: int) -> pd.DataFrame:
    # a handful of releases (e.g. 1908, 1921) prepend an extra title row
    # ("26 octobre 1908,Recensement de 1901,...") above the real header.
    first_line = content.split(b"\n", 1)[0].decode("utf-8-sig", errors="replace")
    skiprows = 1 if "Circonscriptions" not in first_line else 0

    df = pd.read_csv(pd.io.common.BytesIO(content), encoding="utf-8-sig", skiprows=skiprows)
    party_cols = [c for c in df.columns if not _is_metadata_col(c)]

    denom_col = "Votes_valides" if "Votes_valides" in df.columns else "Votes_exprimes"

    long_df = df.melt(
        id_vars=["Circonscriptions"] + ([denom_col] if denom_col in df.columns else []),
        value_vars=party_cols,
        var_name="party_code",
        value_name="votes",
    )
    long_df["votes"] = pd.to_numeric(long_df["votes"], errors="coerce")
    long_df = long_df.dropna(subset=["votes"])

    long_df["vote_share"] = long_df["votes"] / long_df[denom_col] if denom_col in long_df.columns else None
    long_df["jurisdiction_code"] = jurisdiction_code
    long_df["election_date"] = _election_date(jurisdiction_code, year)
    # each historical election's own contemporary map; riding_code here is a
    # name, not a code from any of our other boundary_year vintages, so this
    # is a label for "which map era", not a value joinable against
    # riding_demographics (see module docstring).
    long_df["boundary_year"] = str(year)
    long_df["seat_won"] = None
    long_df = long_df.rename(columns={"Circonscriptions": "riding_code"})

    return long_df[
        ["jurisdiction_code", "election_date", "boundary_year", "riding_code", "party_code", "votes", "vote_share", "seat_won"]
    ]


def download_and_parse_general_elections(jurisdiction_code: str) -> pd.DataFrame:
    prefix = "election-quebecoise-de-" if jurisdiction_code == "qc-provincial" else "election-canadienne-de-"
    resources = list_atlas_resources()
    frames = []
    for res in resources:
        m = re.search(rf"{prefix}(\d{{4}})\.csv$", res["url"])
        if not m:
            continue
        year = int(m.group(1))
        try:
            resp = httpx.get(res["url"], headers={"User-Agent": USER_AGENT}, timeout=30)
            resp.raise_for_status()
            frames.append(parse_election_csv(resp.content, jurisdiction_code, year))
        except Exception as e:
            # ~90 sequential small downloads from a government file server --
            # a single transient timeout/connection reset shouldn't take
            # down the whole pipeline (it did, once: httpx.ConnectTimeout on
            # a TLS handshake). Skip that one file, note it, move on.
            print(f"skipping {res['url']}: {e}")
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()


def load_election_results(con: duckdb.DuckDBPyConnection, df: pd.DataFrame) -> int:
    if df.empty:
        return 0
    con.register("_results_incoming", df)
    con.execute(
        """
        INSERT INTO election_results
        SELECT * FROM _results_incoming
        ON CONFLICT (jurisdiction_code, election_date, boundary_year, riding_code, party_code) DO UPDATE SET
            votes = excluded.votes,
            vote_share = excluded.vote_share
        """
    )
    con.unregister("_results_incoming")
    return len(df)
