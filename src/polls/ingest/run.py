"""Entry point: fetch every source and load into DuckDB.

Quebec vote-intention polls come from Wikipedia's maintained cycle tables
(see ingest/wiki_polls.py for why, and for the coverage comparison). Federal
polls still come from 338canada because the current federal cycle has no
Wikipedia page yet -- the existing ones stop at the 2025 election, and every
federal poll in this database postdates it. That is a known loose end, not a
decision: see TODO.md.
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

import pandas as pd

from polls.db.load import connect, upsert_jurisdiction, upsert_parties, upsert_polls, upsert_poll_shares, upsert_regions
from polls.ingest.demopoll import CA_FEDERAL, parse_source
from polls.ingest.wiki_polls import ingest_qc_polls
from polls.ingest.statcan import download_fed_census_zip, extract_census_csv, load_federal_riding_demographics
from polls.ingest.statcan_provincial import build_provincial_riding_demographics, load_provincial_riding_demographics
from polls.ingest.atlas_historical import download_and_parse_general_elections, load_election_results
from polls.ingest.wiki_riding_results import fetch_all_recent_elections
from polls.ingest.dgeq_bureau_vote import build_all_reprojected_2026_results, download_2026_riding_boundaries
from polls.ingest.byelections import parse_all_byelections
from polls.ingest.sovereignty import parse_sovereignty_polls, JURISDICTION_CODE as SOVEREIGNTY_JURISDICTION_CODE, SEGMENT_LABELS
from polls.ingest.leader_ridings import resolve_leader_ridings
from polls.ingest.wiki_incumbents import build as build_wiki_incumbents

DB_PATH = Path(__file__).parents[3] / "data" / "polls.duckdb"
RAW_DIR = Path(__file__).parents[3] / "data" / "raw"


def ingest_source(con, source) -> list[str]:
    print(f"[{source.jurisdiction_code}] fetching {source.polls_url}")
    polls_df, shares_df, party_order = parse_source(source)
    print(f"[{source.jurisdiction_code}] {len(polls_df)} polls, {len(shares_df)} shares, parties={party_order}")

    upsert_jurisdiction(con, source.jurisdiction_code, source.label, source.source_site)
    upsert_parties(con, source.jurisdiction_code, party_order)
    if not polls_df.is_empty():
        upsert_regions(con, source.jurisdiction_code, polls_df["region_code"].unique().to_list())
    upsert_polls(con, polls_df)
    upsert_poll_shares(con, shares_df)
    return party_order


def main() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    con = connect(DB_PATH)
    n_polls, revisions = ingest_qc_polls(con)
    print(f"[qc-provincial] {n_polls} sondages depuis fr.wikipedia, revisions {revisions}")
    qc_party_order = ["CAQ", "LIB", "QS", "PQ", "PCQ", "AUTRES"]

    ingest_source(con, CA_FEDERAL)

    print("[demographics] fetching StatCan 2021 Census Profile (federal electoral districts)")
    zip_path = download_fed_census_zip(RAW_DIR)
    csv_path = extract_census_csv(zip_path)
    n = load_federal_riding_demographics(con, csv_path)
    print(f"[demographics] {n} federal ridings loaded")

    print("[demographics] building Quebec provincial riding demographics (DA-level spatial join, 2017 map)")
    df = build_provincial_riding_demographics(con, RAW_DIR, boundary_year="2017")
    n = load_provincial_riding_demographics(con, df)
    print(f"[demographics] {n} provincial ridings loaded (2017 map)")

    print("[demographics] building Quebec provincial riding demographics (DA-level spatial join, 2026 map)")
    riding_2026_gdf = download_2026_riding_boundaries(RAW_DIR).rename(columns={"riding_code_2026": "riding_code"})
    df = build_provincial_riding_demographics(con, RAW_DIR, riding_gdf=riding_2026_gdf, boundary_year="2026")
    n = load_provincial_riding_demographics(con, df)
    print(f"[demographics] {n} provincial ridings loaded (2026 map)")

    print("[elections] fetching historical general-election results (Atlas des élections au Québec)")
    for jur in ("qc-provincial", "ca-federal"):
        results_df = download_and_parse_general_elections(jur)
        n = load_election_results(con, results_df)
        n_elections = results_df["election_date"].nunique() if not results_df.empty else 0
        print(f"[elections] {jur}: {n} results across {n_elections} elections loaded")

    print("[elections] fetching riding-level results for elections not in the Atlas (QC 2018/2022, federal 2021/2025)")
    recent_df = fetch_all_recent_elections()
    n = load_election_results(con, recent_df)
    print(f"[elections] {n} riding-level results loaded across {recent_df['election_date'].nunique()} elections")

    print("[elections] reprojecting QC 2018/2022 results onto the 2026 riding map (polling-division spatial join)")
    reprojected_df = build_all_reprojected_2026_results(RAW_DIR)
    n = load_election_results(con, reprojected_df)
    print(f"[elections] {n} reprojected 2026-map results loaded across {reprojected_df['election_date'].nunique()} elections")

    print("[elections] fetching by-election results since the 2022 general election")
    byelection_df = parse_all_byelections(RAW_DIR, qc_party_order)
    n = load_election_results(con, byelection_df)
    print(f"[elections] {n} by-election results loaded across {byelection_df['election_date'].nunique()} by-elections")

    print("[sovereignty] fetching sovereignty-question polling (by age/gender/language subgroup)")
    sov_polls_df, sov_shares_df, sov_options = parse_sovereignty_polls()
    print(f"[sovereignty] {len(sov_polls_df)} polls, {len(sov_shares_df)} shares, options={sov_options}")
    upsert_jurisdiction(con, SOVEREIGNTY_JURISDICTION_CODE, "Question référendaire (sondages)", "qc125.com")
    upsert_parties(con, SOVEREIGNTY_JURISDICTION_CODE, sov_options)
    upsert_regions(con, SOVEREIGNTY_JURISDICTION_CODE, list(SEGMENT_LABELS.keys()), labels=SEGMENT_LABELS)
    upsert_polls(con, sov_polls_df)
    upsert_poll_shares(con, sov_shares_df)

    print("[incumbents] fetching sitting members, current party, retirements and party leaders (fr.wikipedia)")
    riding_names = set(riding_2026_gdf["riding_name_2026"])
    incumbents_df, leaders_df = build_wiki_incumbents(riding_names)
    scraped_at = datetime.now()

    # pandas turns None into NaN in object columns, and DuckDB then coerces
    # that NaN into the literal string "nan" in a VARCHAR column -- so a
    # leader with no seat came out as riding_name="nan" rather than NULL.
    def _null(value):
        return None if value is None or (isinstance(value, float) and pd.isna(value)) else value

    con.execute("DELETE FROM incumbents WHERE jurisdiction_code = 'qc-provincial'")
    for _, row in incumbents_df.iterrows():
        con.execute(
            "INSERT INTO incumbents VALUES ('qc-provincial', ?, ?, ?, ?, ?)",
            [_null(row["riding_name"]), _null(row["member_name"]), _null(row["current_party"]), _null(row["elected_note"]), scraped_at],
        )
    # A leader's riding for the coming election is not necessarily the seat
    # they hold now: they may hold none, or be switching. Both are projectable.
    leaders = resolve_leader_ridings(leaders_df.to_dict("records"), riding_names, incumbents=incumbents_df.to_dict("records"))
    con.execute("ALTER TABLE party_leaders ADD COLUMN IF NOT EXISTS riding_source VARCHAR")
    con.execute("DELETE FROM party_leaders WHERE jurisdiction_code = 'qc-provincial'")
    for row in leaders:
        # Named columns, not positional: ALTER TABLE appends riding_source
        # after scraped_at on an existing database while schema.sql places it
        # before, so the column order differs between a migrated database and
        # a freshly built one.
        con.execute(
            "INSERT INTO party_leaders (jurisdiction_code, party_code, leader_name, riding_name,"
            " riding_source, scraped_at) VALUES ('qc-provincial', ?, ?, ?, ?, ?)",
            [_null(row["party_code"]), _null(row["leader_name"]), _null(row["riding_name"]),
             _null(row.get("riding_source")), scraped_at],
        )
    announced = sum(1 for r in leaders if r.get("riding_source") == "annonce")
    print(f"[incumbents] {announced} chefs avec une candidature annoncee pour 2026")
    n_ind = (incumbents_df["current_party"].isin(["IND", "VACANT"]) | incumbents_df["current_party"].str.startswith("AUTRES")).sum()
    print(f"[incumbents] {len(incumbents_df)} ridings, {n_ind} without a sitting member of the 2022-winning party")
    print(f"[incumbents] {len(leaders_df)} party leaders, {leaders_df['riding_name'].notna().sum()} of them holding a seat")

    con.close()
    print(f"done -> {DB_PATH}")


if __name__ == "__main__":
    main()
