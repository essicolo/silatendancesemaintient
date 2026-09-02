"""StatCan Census Profile ingestion for federal riding demographics.

StatCan publishes the 2021 Census Profile directly aggregated to Federal
Electoral Districts (2023 Representation Order), so no DA-level spatial join
is needed here -- download the bulk product, filter to the FED geography
level, and pivot the handful of characteristics we need.

Quebec *provincial* ridings have no equivalent direct product: StatCan only
goes down to dissemination areas for sub-provincial custom geographies, so
that side needs a DGEQ riding-boundary shapefile + population-weighted DA
aggregation (see ingest/statcan_provincial.py, not yet implemented).
"""

from __future__ import annotations

import zipfile
from pathlib import Path

import duckdb
import httpx

USER_AGENT = "polls-research-bot/0.1 (contact: yysrk9lh@duck.com)"

# 2021 Census Profile, Federal electoral districts (2023 Representation Order).
FED_2023_URL = (
    "https://www12.statcan.gc.ca/census-recensement/2021/dp-pd/prof/details/"
    "download-telecharger/comp/GetFile.cfm?Lang=E&FILETYPE=CSV&GEONO=029"
)

# characteristic_id -> (schema column, is_rate)
# Rate columns (C10_RATE_TOTAL) are StatCan-computed percentages of the
# matching denominator characteristic; count columns are used where no rate
# is published (household income).
CHARACTERISTICS = {
    40: ("median_age", True),
    243: ("median_household_income", False),
    738: ("pct_english_home_lang", True),
    739: ("pct_french_home_lang", True),
    1529: ("pct_immigrant", True),
    2008: ("pct_university_degree", True),
    # Cultural diversity, education floor, and economic structure. Immigration
    # (1529) and visible-minority share (1684) are related but not the same
    # thing -- a riding can be heavily immigrant and not visibly diverse (or
    # vice versa), and they may not move vote share the same way, so both are
    # kept rather than treating one as a proxy for the other.
    1684: ("pct_visible_minority", True),
    2015: ("pct_no_diploma", True),  # ages 25-64, the education *floor* rather than the university ceiling
    2262: ("pct_ind_agriculture", True),
    2266: ("pct_ind_manufacturing", True),
    2268: ("pct_ind_retail", True),
    2273: ("pct_ind_professional", True),
    2277: ("pct_ind_health_social", True),
}

# Canonical riding_demographics column order, matching db/schema.sql. Defined
# once here because BOTH statcan.py (federal) and statcan_provincial.py
# (Quebec, via DA aggregation) insert into that table with positional
# `SELECT *` -- keeping two hand-maintained lists in sync was already a
# latent bug waiting to silently shift every column by one.
RIDING_DEMOGRAPHICS_COLUMNS = [
    "jurisdiction_code",
    "boundary_year",
    "riding_code",
    "census_year",
    "pct_french_home_lang",
    "pct_english_home_lang",
    "pct_allophone_home_lang",
    "median_age",
    "median_household_income",
    "pct_university_degree",
    "pct_immigrant",
    "population_density",
    "pct_urban",
    "pct_visible_minority",
    "pct_no_diploma",
    "pct_ind_agriculture",
    "pct_ind_manufacturing",
    "pct_ind_retail",
    "pct_ind_professional",
    "pct_ind_health_social",
]


def download_fed_census_zip(dest_dir: Path) -> Path:
    dest_dir.mkdir(parents=True, exist_ok=True)
    zip_path = dest_dir / "statcan_fed2023.zip"
    if zip_path.exists():
        return zip_path
    resp = httpx.get(FED_2023_URL, headers={"User-Agent": USER_AGENT}, timeout=180, follow_redirects=True)
    resp.raise_for_status()
    zip_path.write_bytes(resp.content)
    return zip_path


def extract_census_csv(zip_path: Path) -> Path:
    csv_name = "98-401-X2021029_English_CSV_data.csv"
    csv_path = zip_path.parent / csv_name
    if not csv_path.exists():
        with zipfile.ZipFile(zip_path) as z:
            z.extract(csv_name, zip_path.parent)
    return csv_path


def load_federal_riding_demographics(con: duckdb.DuckDBPyConnection, csv_path: Path, census_year: int = 2021) -> int:
    """Pivot the long-format census CSV into riding_demographics rows for
    every Federal electoral district in Canada, keyed by ALT_GEO_CODE
    (5-digit FED code, e.g. '24001' -- province prefix 24 = Quebec)."""

    id_list = ", ".join(str(cid) for cid in CHARACTERISTICS)
    pivot_cols = ", ".join(
        f"MAX(CASE WHEN CHARACTERISTIC_ID = {cid} THEN "
        f"{'C10_RATE_TOTAL' if is_rate else 'C1_COUNT_TOTAL'} END) AS {col}"
        for cid, (col, is_rate) in CHARACTERISTICS.items()
    )

    df = con.execute(
        f"""
        SELECT
            ALT_GEO_CODE AS riding_code,
            {pivot_cols}
        FROM read_csv(?, ignore_errors=true)
        WHERE GEO_LEVEL LIKE 'Federal electoral district%'
          AND CHARACTERISTIC_ID IN ({id_list})
        GROUP BY ALT_GEO_CODE
        """,
        [str(csv_path)],
    ).df()

    df["pct_allophone_home_lang"] = (100.0 - df["pct_french_home_lang"] - df["pct_english_home_lang"]).clip(lower=0)
    df["jurisdiction_code"] = "ca-federal"
    df["boundary_year"] = "2023"  # Federal electoral districts, 2023 Representation Order
    df["census_year"] = census_year
    df["population_density"] = None  # suppressed at FED level in this product; see module docstring
    df["pct_urban"] = None  # not published at FED level

    df = df[RIDING_DEMOGRAPHICS_COLUMNS]

    con.register("_riding_demo_incoming", df)
    con.execute(
        """
        INSERT INTO riding_demographics
        SELECT * FROM _riding_demo_incoming
        ON CONFLICT (jurisdiction_code, boundary_year, riding_code, census_year) DO UPDATE SET
            pct_french_home_lang = excluded.pct_french_home_lang,
            pct_english_home_lang = excluded.pct_english_home_lang,
            pct_allophone_home_lang = excluded.pct_allophone_home_lang,
            median_age = excluded.median_age,
            median_household_income = excluded.median_household_income,
            pct_university_degree = excluded.pct_university_degree,
            pct_immigrant = excluded.pct_immigrant
        """
    )
    con.unregister("_riding_demo_incoming")
    return len(df)
