"""Classify each 2026-map riding into qc125's own polling regions (Montréal
RMR / Québec RMR / Ailleurs au Québec), via StatCan's official CMA
boundaries -- "RMR" is the French term for what StatCan calls a Census
Metropolitan Area, so this should match qc125's own region definitions
exactly rather than approximate them.

This is the missing piece for a region-adjusted swing model: qc125 already
publishes regional poll splits (see ingest/demopoll.py, region_code
National/MTL/QC/REG) that this project scraped from turn one but never used
for anything besides the national trend -- fitting one GP per region and
swinging each riding using ITS OWN region's movement, instead of always the
national number, is a direct, data-grounded way to capture e.g. Montréal
being more PLQ/QS than the province overall.
"""

from __future__ import annotations

from pathlib import Path

import geopandas as gpd
import httpx
import pandas as pd

from polls.ingest.dgeq_bureau_vote import download_2026_riding_boundaries
from polls.ingest.statcan import USER_AGENT

CMA_BOUNDARY_URL = (
    "https://www12.statcan.gc.ca/census-recensement/2021/geo/sip-pis/boundary-limites/files-fichiers/lcma000b21a_e.zip"
)
MONTREAL_CMAUID = "462"
QUEBEC_CMAUID = "421"


def download_cma_boundaries(raw_dir: Path) -> gpd.GeoDataFrame:
    out_dir = raw_dir / "cma_boundaries_2021"
    shp_path = out_dir / "lcma000b21a_e.shp"
    if not shp_path.exists():
        zip_path = raw_dir / "cma_boundaries_2021.zip"
        if not zip_path.exists():
            resp = httpx.get(CMA_BOUNDARY_URL, headers={"User-Agent": USER_AGENT}, timeout=120, follow_redirects=True)
            resp.raise_for_status()
            zip_path.write_bytes(resp.content)
        import zipfile

        with zipfile.ZipFile(zip_path) as z:
            z.extractall(out_dir)
    return gpd.read_file(shp_path)


def build_riding_region_map(raw_dir: Path) -> pd.DataFrame:
    """Returns DataFrame[riding_code, region_code] for the 2026 map,
    region_code in {"MTL", "QC", "REG"} matching qc125's own taxonomy."""
    cma = download_cma_boundaries(raw_dir)
    mtl_geom = cma[cma["CMAUID"] == MONTREAL_CMAUID].geometry.union_all()
    qc_geom = cma[cma["CMAUID"] == QUEBEC_CMAUID].geometry.union_all()

    ridings = download_2026_riding_boundaries(raw_dir).to_crs(cma.crs)
    centroids = ridings.geometry.centroid

    def classify(pt):
        if mtl_geom.contains(pt):
            return "MTL"
        if qc_geom.contains(pt):
            return "QC"
        return "REG"

    return pd.DataFrame(
        {"riding_code": ridings["riding_code_2026"].astype(str), "region_code": centroids.apply(classify)}
    )
