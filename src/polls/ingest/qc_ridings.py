"""Quebec provincial riding (circonscription) boundaries.

Élections Québec does not publish an open downloadable GIS file for its own
riding map (only an interactive viewer). The authoritative geometry is
however mirrored by Represent (Open North's civic-data API, used across
Canadian civic-tech projects), sourced directly from Élections Québec:
https://represent.opennorth.ca/boundary-sets/quebec-electoral-districts-2017/

That boundary set is the one in force for the 2018 and 2022 general
elections (2017 redistribution, 125 ridings) and covers this project's
poll history (2018-present).
"""

from __future__ import annotations

import json
from pathlib import Path

import geopandas as gpd
import httpx
from shapely.geometry import shape

USER_AGENT = "polls-research-bot/0.1 (contact: yysrk9lh@duck.com)"
BOUNDARY_SET = "quebec-electoral-districts-2017"
BASE_URL = "https://represent.opennorth.ca"


def download_riding_boundaries(dest_dir: Path) -> gpd.GeoDataFrame:
    """Fetch riding geometries + stable codes, cache as GeoJSON, return a
    GeoDataFrame with columns [riding_code, riding_name, geometry] in the
    ISQ census layer's CRS (NAD83 / Quebec Albers) for area-based joins."""

    dest_dir.mkdir(parents=True, exist_ok=True)
    cache_path = dest_dir / "qc_ridings_2017.geojson"

    if not cache_path.exists():
        meta_resp = httpx.get(
            f"{BASE_URL}/boundaries/{BOUNDARY_SET}/",
            params={"limit": 200},
            headers={"User-Agent": USER_AGENT},
            timeout=30,
        )
        meta_resp.raise_for_status()
        meta = {obj["name"]: obj["external_id"] for obj in meta_resp.json()["objects"]}

        shapes_resp = httpx.get(
            f"{BASE_URL}/boundaries/{BOUNDARY_SET}/shape",
            headers={"User-Agent": USER_AGENT},
            timeout=120,
            follow_redirects=True,
        )
        shapes_resp.raise_for_status()
        objects = shapes_resp.json()["objects"]

        features = [
            {
                "type": "Feature",
                "geometry": obj["shape"],
                "properties": {
                    "riding_name": obj["name"],
                    "riding_code": meta.get(obj["name"], obj["name"]),
                },
            }
            for obj in objects
        ]
        cache_path.write_text(
            json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False),
            encoding="utf-8",
        )

    gdf = gpd.read_file(cache_path)
    gdf = gdf.set_crs("EPSG:4326")
    return gdf[["riding_code", "riding_name", "geometry"]]
