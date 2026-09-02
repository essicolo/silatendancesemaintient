"""By-election (élection partielle) results since the 2022 general election:
real votes in specific ridings, more recent and far less noisy than any
poll for that riding, and directly usable to refresh a riding's baseline
instead of relying on the now-stale 2022 general result for it.

Time-relevance matters here in a way it doesn't for the general-election
baseline: a by-election's local result should only be swung forward from
ITS OWN date to now, not from 2022 -- applying a full 2022-to-now national
swing on top of an already-2025-dated local result would double-count
whatever movement happened between 2022 and that by-election.
"""

from __future__ import annotations

from pathlib import Path

import pandas as pd

from polls.ingest.dgeq_bureau_vote import download_bv_results_zip, parse_bv_results

# By-elections held since the 2022-10-03 general election (2017 map --
# 2026 redistricting only takes effect for the next general election).
BYELECTION_DATES = ["2023-03-13", "2023-10-02", "2025-03-17", "2025-08-11", "2026-02-23"]


def parse_byelection_results(election_date: str, raw_dir: Path, party_codes: list[str]) -> pd.DataFrame:
    zip_path = download_bv_results_zip(election_date, raw_dir, kind="part")
    results = parse_bv_results(zip_path)
    totals = results[results["is_total_row"]].copy()
    totals["party_code"] = totals["party_code"].apply(lambda p: p if p in party_codes else "AUTRES")
    totals = totals.groupby(["riding_name", "party_code"])["votes"].sum().reset_index()

    rows = []
    for riding, group in totals.groupby("riding_name"):
        total_votes = group["votes"].sum()
        for _, row in group.iterrows():
            rows.append(
                {
                    "jurisdiction_code": "qc-provincial",
                    "election_date": election_date,
                    "boundary_year": "2017",
                    "riding_code": riding,
                    "party_code": row["party_code"],
                    "votes": row["votes"],
                    "vote_share": row["votes"] / total_votes,
                    "seat_won": row["votes"] == group["votes"].max(),
                }
            )
    return pd.DataFrame(rows)


def parse_all_byelections(raw_dir: Path, party_codes: list[str]) -> pd.DataFrame:
    frames = [parse_byelection_results(d, raw_dir, party_codes) for d in BYELECTION_DATES]
    return pd.concat(frames, ignore_index=True)
