"""Quebec *provincial* riding demographics: no direct StatCan product exists
for this geography (see statcan.py docstring), so this module does the
DA-level spatial join + population-weighted aggregation by hand:

  1. Each dissemination area (DA) polygon is assigned to exactly one riding
     by its centroid (the standard approach for building census-to-district
     correspondence files; a handful of DAs that straddle a riding boundary
     are assigned whole to their centroid's riding rather than split by
     area, which would require much finer DA-level population rasters to
     do accurately).
  2. Riding-level rates are the DA-population-weighted average of the
     matching DA-level rate; the household-income column is likewise
     population-weighted (an approximation -- ideally household-weighted,
     but household counts aren't part of this characteristic subset).

Inputs:
  - DA boundary polygons + population: ISQ's harmonized census geography
    (see ingest/qc_ridings.py-adjacent download in ingest/run.py).
  - DA-level census characteristics: the StatCan Quebec DA-level Census
    Profile bulk CSV, pre-filtered to GEO_LEVEL='Dissemination area' and the
    characteristic IDs we need (the unfiltered file is ~6.4 GB).
  - Riding polygons: ingest/qc_ridings.py.
"""

from __future__ import annotations

import csv
import io
import zipfile
from pathlib import Path

import duckdb
import geopandas as gpd
import httpx
import pandas as pd

from polls.ingest.qc_ridings import download_riding_boundaries
from polls.ingest.statcan import CHARACTERISTICS, RIDING_DEMOGRAPHICS_COLUMNS, USER_AGENT  # reuse the same characteristic map

ISQ_DA_LAYER = "AD_2021_QC_LimCarto_harmo"

ISQ_GEO_SHP_URL = (
    "https://www.donneesquebec.ca/recherche/dataset/1c54bc07-3fd7-489b-bcb5-3f318ec22255/"
    "resource/7e003825-bf3b-4d8a-aee0-fada036652cf/download/geo_recensement_2021_qc_harmonise_isq_format_shp.zip"
)
STATCAN_DA_QC_URL = (
    "https://www12.statcan.gc.ca/census-recensement/2021/dp-pd/prof/details/"
    "download-telecharger/comp/GetFile.cfm?Lang=E&FILETYPE=CSV&GEONO=006_Quebec"
)


def download_isq_da_shapefile(raw_dir: Path) -> Path:
    """Download + extract just the DA (AD_*) layer from the ISQ harmonized
    census geography package (the full zip also has CD/CSD/economic-region
    layers we don't need here)."""
    out_dir = raw_dir / "isq_geo"
    shp_path = out_dir / f"{ISQ_DA_LAYER}.shp"
    if shp_path.exists():
        return out_dir

    zip_path = raw_dir / "isq_geo_2021_shp.zip"
    if not zip_path.exists():
        resp = httpx.get(ISQ_GEO_SHP_URL, headers={"User-Agent": USER_AGENT}, timeout=300, follow_redirects=True)
        resp.raise_for_status()
        zip_path.write_bytes(resp.content)

    with zipfile.ZipFile(zip_path) as z:
        members = [n for n in z.namelist() if n.startswith(ISQ_DA_LAYER)]
        z.extractall(out_dir, members=members)
    return out_dir


def download_and_filter_da_census_csv(raw_dir: Path) -> Path:
    """Download the ~530MB Quebec DA-level Census Profile bulk CSV and
    stream-filter it down to just the dissemination-area rows for the
    characteristics we need (~20MB). Streamed straight out of the zip
    member to avoid an extra 6.4GB extraction step."""
    filtered_path = raw_dir / "statcan_da_qc_filtered.csv"
    if filtered_path.exists():
        return filtered_path

    zip_path = raw_dir / "statcan_da_qc.zip"
    if not zip_path.exists():
        # Download to a .part file and only rename on success: a read
        # timeout partway through this ~540MB transfer (which happens) would
        # otherwise leave a truncated zip that the `zip_path.exists()` check
        # above happily treats as a valid cache on the next run.
        part_path = zip_path.with_suffix(".zip.part")
        # generous per-read timeout, not just a total budget: the default
        # 5s read timeout is what actually failed here, mid-stream.
        timeout = httpx.Timeout(connect=30.0, read=120.0, write=30.0, pool=30.0)
        with httpx.stream(
            "GET", STATCAN_DA_QC_URL, headers={"User-Agent": USER_AGENT}, timeout=timeout, follow_redirects=True
        ) as resp:
            resp.raise_for_status()
            with open(part_path, "wb") as f:
                for chunk in resp.iter_bytes(chunk_size=1 << 20):
                    f.write(chunk)
        part_path.replace(zip_path)

    char_ids = {str(cid) for cid in CHARACTERISTICS} | {"1", "735"}
    with zipfile.ZipFile(zip_path) as z:
        (csv_name,) = [n for n in z.namelist() if n.endswith(".csv") and "data" in n.lower()]
        with z.open(csv_name) as f, open(filtered_path, "w", encoding="utf-8", newline="") as out_f:
            reader = csv.reader(io.TextIOWrapper(f, encoding="utf-8", errors="replace"))
            writer = csv.writer(out_f)
            header = next(reader)
            writer.writerow(header)
            idx_geolevel = header.index("GEO_LEVEL")
            idx_charid = header.index("CHARACTERISTIC_ID")
            for row in reader:
                if row[idx_geolevel] == "Dissemination area" and row[idx_charid] in char_ids:
                    writer.writerow(row)

    return filtered_path


def load_da_polygons(isq_shp_dir: Path) -> gpd.GeoDataFrame:
    gdf = gpd.read_file(isq_shp_dir / f"{ISQ_DA_LAYER}.shp")
    gdf = gdf.dropna(subset=["ADIDU"])
    return gdf.rename(columns={"ADIDU": "da_id"})[["da_id", "Population", "Superf_tot", "geometry"]]


def assign_da_to_ridings(da_gdf: gpd.GeoDataFrame, riding_gdf: gpd.GeoDataFrame) -> pd.DataFrame:
    riding_gdf = riding_gdf.to_crs(da_gdf.crs)
    centroids = gpd.GeoDataFrame(
        da_gdf[["da_id", "Population", "Superf_tot"]], geometry=da_gdf.geometry.centroid, crs=da_gdf.crs
    )
    joined = gpd.sjoin(centroids, riding_gdf, how="left", predicate="within")
    unmatched = joined["riding_code"].isna().sum()
    if unmatched:
        # centroid can fall just outside all polygons for slivers along the
        # coastline/border; snap those to the nearest riding instead of
        # dropping the population they represent.
        missing = joined[joined["riding_code"].isna()][["da_id"]].merge(da_gdf, on="da_id")
        missing_gdf = gpd.GeoDataFrame(missing, geometry="geometry", crs=da_gdf.crs)
        nearest = gpd.sjoin_nearest(missing_gdf[["da_id", "geometry"]], riding_gdf, how="left")
        fix = dict(zip(nearest["da_id"], nearest["riding_code"]))
        joined.loc[joined["riding_code"].isna(), "riding_code"] = joined.loc[
            joined["riding_code"].isna(), "da_id"
        ].map(fix)
    return joined[["da_id", "Population", "Superf_tot", "riding_code"]]


def load_da_characteristics(con: duckdb.DuckDBPyConnection, filtered_csv_path: Path) -> pd.DataFrame:
    id_list = ", ".join(str(cid) for cid in CHARACTERISTICS)
    pivot_cols = ", ".join(
        f"MAX(CASE WHEN CHARACTERISTIC_ID = {cid} THEN "
        f"{'C10_RATE_TOTAL' if is_rate else 'C1_COUNT_TOTAL'} END) AS {col}"
        for cid, (col, is_rate) in CHARACTERISTICS.items()
    )
    return con.execute(
        f"""
        SELECT ALT_GEO_CODE AS da_id, {pivot_cols}
        FROM read_csv(?, ignore_errors=true)
        WHERE CHARACTERISTIC_ID IN ({id_list})
        GROUP BY ALT_GEO_CODE
        """,
        [str(filtered_csv_path)],
    ).df()


def _weighted_avg(df: pd.DataFrame, value_col: str, weight_col: str) -> pd.Series:
    valid = df.dropna(subset=[value_col]).copy()
    valid["_product"] = valid[value_col] * valid[weight_col]
    sums = valid.groupby("riding_code")[["_product", weight_col]].sum()
    return sums["_product"] / sums[weight_col].replace(0, pd.NA)


def build_provincial_riding_demographics(
    con: duckdb.DuckDBPyConnection,
    raw_dir: Path,
    riding_gdf: gpd.GeoDataFrame | None = None,
    boundary_year: str = "2017",
    census_year: int = 2021,
) -> pd.DataFrame:
    """riding_gdf must have columns [riding_code, geometry]; defaults to the
    2017-map boundaries (ingest/qc_ridings.py) if not given. Pass the DGEQ
    2026 riding shapefile (see ingest/dgeq_bureau_vote.py) with
    boundary_year='2026' to build the forward-looking version."""
    isq_shp_dir = download_isq_da_shapefile(raw_dir)
    filtered_csv_path = download_and_filter_da_census_csv(raw_dir)
    da_gdf = load_da_polygons(isq_shp_dir)
    if riding_gdf is None:
        riding_gdf = download_riding_boundaries(raw_dir)
    assignment = assign_da_to_ridings(da_gdf, riding_gdf)

    characteristics = load_da_characteristics(con, filtered_csv_path)
    characteristics["da_id"] = characteristics["da_id"].astype(str)
    assignment["da_id"] = assignment["da_id"].astype(str)

    merged = assignment.merge(characteristics, on="da_id", how="left")
    # weight by DA population from the shapefile (always present) rather
    # than the census count characteristic (occasionally suppressed for
    # small/low-population DAs).
    weight_col = "Population"

    # Every characteristic pulled from the census (see statcan.py's
    # CHARACTERISTICS) gets the same population-weighted DA -> riding
    # aggregation, rather than a hand-listed subset that silently drops any
    # newly-added characteristic.
    aggregated = {
        col: _weighted_avg(merged, col, weight_col)
        for _, (col, _is_rate) in CHARACTERISTICS.items()
        if col in merged.columns
    }
    out = pd.DataFrame(aggregated).reset_index()

    out["pct_allophone_home_lang"] = (100.0 - out["pct_french_home_lang"] - out["pct_english_home_lang"]).clip(lower=0)

    # Superf_tot is in km^2 (ISQ harmonized geography); land-area weighted
    # population density per riding, computed directly rather than left
    # null as it is for the federal product (see statcan.py docstring).
    area_pop = merged.groupby("riding_code")[["Population", "Superf_tot"]].sum()
    density = (area_pop["Population"] / area_pop["Superf_tot"].replace(0, pd.NA)).rename("population_density")
    out = out.merge(density, on="riding_code", how="left")

    out["jurisdiction_code"] = "qc-provincial"
    out["boundary_year"] = boundary_year
    out["census_year"] = census_year
    out["pct_urban"] = None

    return out[RIDING_DEMOGRAPHICS_COLUMNS]


def load_provincial_riding_demographics(con: duckdb.DuckDBPyConnection, df: pd.DataFrame) -> int:
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
            pct_immigrant = excluded.pct_immigrant,
            population_density = excluded.population_density
        """
    )
    con.unregister("_riding_demo_incoming")
    return len(df)
