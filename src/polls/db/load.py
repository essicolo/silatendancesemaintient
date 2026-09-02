"""DuckDB loading helpers: idempotent upsert of scraped polls/shares."""

from __future__ import annotations

from pathlib import Path

import duckdb
import polars as pl

SCHEMA_PATH = Path(__file__).with_name("schema.sql")


def connect(db_path: str | Path) -> duckdb.DuckDBPyConnection:
    con = duckdb.connect(str(db_path))
    con.execute(SCHEMA_PATH.read_text(encoding="utf-8"))
    return con


def upsert_jurisdiction(con: duckdb.DuckDBPyConnection, jurisdiction_code: str, label: str, source_site: str) -> None:
    con.execute(
        """
        INSERT INTO jurisdictions VALUES (?, ?, ?)
        ON CONFLICT (jurisdiction_code) DO UPDATE SET label = excluded.label, source_site = excluded.source_site
        """,
        [jurisdiction_code, label, source_site],
    )


def upsert_parties(con: duckdb.DuckDBPyConnection, jurisdiction_code: str, party_order: list[str]) -> None:
    for i, code in enumerate(party_order):
        con.execute(
            """
            INSERT INTO parties VALUES (?, ?, NULL, ?)
            ON CONFLICT (jurisdiction_code, party_code) DO UPDATE SET display_order = excluded.display_order
            """,
            [jurisdiction_code, code, i],
        )
    con.execute(
        """
        INSERT INTO parties VALUES (?, 'AUTRES', 'Autres / indépendants', ?)
        ON CONFLICT (jurisdiction_code, party_code) DO NOTHING
        """,
        [jurisdiction_code, len(party_order)],
    )


def upsert_regions(
    con: duckdb.DuckDBPyConnection, jurisdiction_code: str, region_codes: list[str], labels: dict[str, str] | None = None
) -> None:
    labels = labels or {}
    for code in region_codes:
        con.execute(
            """
            INSERT INTO regions VALUES (?, ?, ?)
            ON CONFLICT (jurisdiction_code, region_code) DO UPDATE SET region_label = excluded.region_label
            """,
            [jurisdiction_code, code, labels.get(code, code)],
        )


def upsert_polls(con: duckdb.DuckDBPyConnection, polls_df: pl.DataFrame) -> None:
    if polls_df.is_empty():
        return
    con.register("_polls_incoming", polls_df)
    con.execute(
        """
        INSERT INTO polls
        SELECT * FROM _polls_incoming
        ON CONFLICT (poll_id) DO UPDATE SET
            sample_size = excluded.sample_size,
            firm_rating = excluded.firm_rating,
            scraped_at = excluded.scraped_at
        """
    )
    con.unregister("_polls_incoming")


def upsert_poll_shares(con: duckdb.DuckDBPyConnection, shares_df: pl.DataFrame) -> None:
    if shares_df.is_empty():
        return
    con.register("_shares_incoming", shares_df)
    con.execute(
        """
        INSERT INTO poll_shares
        SELECT * FROM _shares_incoming
        ON CONFLICT (poll_id, party_code) DO UPDATE SET pct_reported = excluded.pct_reported
        """
    )
    con.unregister("_shares_incoming")
