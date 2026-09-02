"""Riding-boundary-invariant provincial election results, built from
Élections Québec's own open-data portal (dgeq.org -- not indexed on Données
Québec, found via a footnote link on their "results by polling station"
help page).

Strategy: polling divisions ("sections de vote") are tiny and redrawn far
less disruptively than ridings, and DGEQ publishes both their boundaries and
candidate-level results per election. So instead of trusting a riding-name
match across redistrictings (fragile: names/boundaries change), each
election's polling-division results are areally reprojected onto whatever
target riding map we need via spatial join -- the same DA-to-riding pattern
used for riding_demographics, just applied to votes instead of census
counts. This is what makes the pipeline resilient to the 2026 redistricting
(125 -> 127 ridings): 2018 and 2022 results (both on the 2017/125-riding
map) get re-expressed on the 2026/127-riding map before they're used as a
swing-model baseline for the 2026 election.

Votes cast outside a specific polling division (advance voting, mail-in,
returning-officer-office voting -- documented by DGEQ as up to ~40% of
ballots in some ridings) appear in the source CSV as rows with a blank
S.V. (polling-division) number, grouped by riding rather than by
sub-riding location. These can't be spatially reaggregated at all, so they
are distributed across target ridings in the same proportion as that source
riding's *geolocatable* votes -- i.e. we assume advance/mail voters within
one old riding split across new ridings the same way day-of voters did.
That's an approximation, not a measurement; it's noted here and in
election_results.boundary_year so it can be revisited if it turns out to
matter.
"""

from __future__ import annotations

import re
import zipfile
from pathlib import Path

import geopandas as gpd
import httpx
import pandas as pd

USER_AGENT = "polls-research-bot/0.1 (contact: yysrk9lh@duck.com)"

RESULTS_URL_TEMPLATE = (
    "https://donnees.electionsquebec.qc.ca/production/provincial/resultats/archives/{prefix}{date}/resultats-bureau-vote.zip"
)
SV_SHAPEFILE_URLS = {
    2018: "https://donnees.electionsquebec.qc.ca/autres/provincial/sections_vote_2018_shapefile.zip",
    2022: "https://donnees.electionsquebec.qc.ca/autres/provincial/sections_vote_2022_shapefile.zip",
}
RIDING_2026_SHAPEFILE_URL = (
    "https://donnees.electionsquebec.qc.ca/autres/provincial/circonscriptions_electorales_2026_shapefile.zip"
)

# Longest/most-specific patterns first so e.g. "P.C.Q" doesn't get
# swallowed by a laxer "P.Q." match. Periods optional: DGEQ has used both
# "P.Q." and bare "PQ" across different files (the by-election CSVs from
# 2026-02 dropped periods entirely) -- not made fully dot-free everywhere
# (e.g. requiring a literal "P.Co.Q." variant to stay unmatched) since a
# too-loose pattern risks false-matching an unrelated micro-party's initials.
PARTY_ABBREV_PATTERNS = [
    (re.compile(r"C\.?A\.?Q\.?"), "CAQ"),
    (re.compile(r"P\.?C\.?Q\.?(?!\.?[A-Za-z])"), "PCQ"),  # not followed by another letter, so "PCOQ" stays unmatched
    (re.compile(r"P\.?L\.?Q\.?|Q\.?L\.?P\.?"), "LIB"),
    (re.compile(r"Q\.?S\.?"), "QS"),
    (re.compile(r"P\.?V\.?Q\.?|P\.?V\.?"), "AUTRES:VERT"),
    (re.compile(r"P\.?Q\.?"), "PQ"),
]


def _party_code_from_header(col: str) -> str:
    for pattern, code in PARTY_ABBREV_PATTERNS:
        if pattern.search(col):
            return code
    return f"AUTRES:{col.strip()}"


def _candidate_name_from_header(col: str) -> str:
    """Column headers are "Lastname Firstname PARTY.ABBREV." -- take
    everything before the first recognized party abbreviation as the name.
    Falls back to the raw column text for independents/unrecognized
    abbreviations, which is an acceptable imprecision here: this is only
    used for incumbency matching, and independents are rarely the party
    whose local swing we're trying to correct for."""
    earliest = None
    for pattern, _ in PARTY_ABBREV_PATTERNS:
        m = pattern.search(col)
        if m and (earliest is None or m.start() < earliest):
            earliest = m.start()
    return col[:earliest].strip() if earliest is not None else col.strip()


def download_bv_results_zip(election_date: str, raw_dir: Path, kind: str = "gen") -> Path:
    """kind: 'gen' for a general election, 'part' for a by-election
    (élection partielle) -- DGEQ prefixes the archive folder differently."""
    zip_path = raw_dir / f"dgeq_bv_{kind}_{election_date}.zip"
    if zip_path.exists():
        return zip_path
    url = RESULTS_URL_TEMPLATE.format(prefix=kind, date=election_date)
    resp = httpx.get(url, headers={"User-Agent": USER_AGENT}, timeout=120, follow_redirects=True)
    resp.raise_for_status()
    zip_path.write_bytes(resp.content)
    return zip_path


def parse_bv_results(zip_path: Path) -> pd.DataFrame:
    """Long-format: one row per (source riding, S.V. number or None for
    grouped/advance votes, party). S.V. is None for the non-geolocatable
    grouped-vote rows and the riding-total row."""
    rows = []
    with zipfile.ZipFile(zip_path) as z:
        for name in z.namelist():
            if not name.endswith(".csv"):
                continue
            with z.open(name) as f:
                text = f.read().decode("cp1252")
            lines = text.splitlines()
            header = lines[0].split(";")
            # candidate columns run from the elector-count column to the
            # first "valid ballots" column -- located by name (both are at
            # a fixed position, 9 and end-2/3, but DGEQ has used at least
            # two different header-naming conventions across files: older
            # abbreviated "S.V.;É.I....;B.V.;B.R." vs a newer spelled-out
            # "Section de vote;Électeurs inscrits...;Bulletins valides;
            # Bulletins rejetés", seen on by-election files from 2025+).
            end_markers = ("B.V.", "Bulletins valides")
            end_idx = next((header.index(m) for m in end_markers if m in header), None)
            if end_idx is None:
                raise ValueError(f"unrecognized header format in {name}: no end-of-candidates marker found")
            candidate_cols = header[9:end_idx]
            party_codes = [_party_code_from_header(c) for c in candidate_cols]
            candidate_names = [_candidate_name_from_header(c) for c in candidate_cols]

            for line in lines[1:]:
                cells = line.split(";")
                if len(cells) < len(header):
                    continue
                riding_name = cells[1].strip()
                sv_raw = cells[7]
                is_total_row = cells[4].strip().lower().startswith("total de la circonscription")
                is_majority_row = "majorit" in cells[4].strip().lower()
                if is_majority_row:
                    continue
                sv_number = None
                if not is_total_row:
                    try:
                        sv_number = int(sv_raw)
                    except ValueError:
                        sv_number = None  # grouped/advance/mail votes: no single polling division

                for col_idx, party_code, candidate_name in zip(
                    range(9, 9 + len(candidate_cols)), party_codes, candidate_names
                ):
                    try:
                        votes = int(cells[col_idx])
                    except (ValueError, IndexError):
                        continue
                    rows.append(
                        {
                            "riding_name": riding_name,
                            "sv_number": sv_number,
                            "is_total_row": is_total_row,
                            "party_code": party_code,
                            "candidate_name": candidate_name,
                            "votes": votes,
                        }
                    )
    return pd.DataFrame(rows)


def download_sv_boundaries(year: int, raw_dir: Path) -> gpd.GeoDataFrame:
    out_dir = raw_dir / f"sv_{year}"
    if not out_dir.exists():
        zip_path = raw_dir / f"sv_{year}.zip"
        if not zip_path.exists():
            resp = httpx.get(SV_SHAPEFILE_URLS[year], headers={"User-Agent": USER_AGENT}, timeout=120, follow_redirects=True)
            resp.raise_for_status()
            zip_path.write_bytes(resp.content)
        with zipfile.ZipFile(zip_path) as z:
            z.extractall(out_dir)

    shp_paths = list(out_dir.rglob("Section*de*vote*.shp")) or list(out_dir.rglob("*.shp"))
    gdf = gpd.read_file(shp_paths[0])

    if year == 2018:
        gdf = gdf.rename(columns={"NO_SV": "sv_number", "NM_CEP": "riding_name"})
    else:
        gdf = gdf.rename(columns={"NO_SV_VG": "sv_number", "NM_CEP_VG": "riding_name"})
    gdf["sv_number"] = pd.to_numeric(gdf["sv_number"], errors="coerce")
    return gdf[["riding_name", "sv_number", "geometry"]].dropna(subset=["sv_number"])


def download_2026_riding_boundaries(raw_dir: Path) -> gpd.GeoDataFrame:
    out_dir = raw_dir / "circonscriptions_2026"
    if not out_dir.exists():
        zip_path = raw_dir / "circonscriptions_2026.zip"
        if not zip_path.exists():
            resp = httpx.get(RIDING_2026_SHAPEFILE_URL, headers={"User-Agent": USER_AGENT}, timeout=120, follow_redirects=True)
            resp.raise_for_status()
            zip_path.write_bytes(resp.content)
        with zipfile.ZipFile(zip_path) as z:
            z.extractall(out_dir)
    shp_path = next(out_dir.rglob("*.shp"))
    gdf = gpd.read_file(shp_path).rename(columns={"CO_CEP": "riding_code_2026", "NM_CEP": "riding_name_2026"})
    return gdf[["riding_code_2026", "riding_name_2026", "geometry"]]


def reproject_results_to_2026(
    results: pd.DataFrame,
    sv_gdf: gpd.GeoDataFrame,
    riding_2026_gdf: gpd.GeoDataFrame,
    jurisdiction_code: str,
    election_date: str,
) -> pd.DataFrame:
    """Areal-interpolation reaggregation: assign each polling division to a
    2026 riding by centroid, derive each source riding's vote-share split
    across 2026 ridings from its *geolocatable* SVs, then apply that split
    to the source riding's true total (including grouped/advance votes)."""

    riding_2026_gdf = riding_2026_gdf.to_crs(sv_gdf.crs)
    sv_points = sv_gdf.copy()
    sv_points["geometry"] = sv_points.geometry.centroid
    joined = gpd.sjoin(sv_points, riding_2026_gdf, how="left", predicate="within")
    missing = joined["riding_code_2026"].isna()
    if missing.any():
        nearest = gpd.sjoin_nearest(sv_points[missing][["geometry"]], riding_2026_gdf, how="left")
        joined.loc[missing, "riding_code_2026"] = nearest["riding_code_2026"].values

    sv_to_2026 = joined[["riding_name", "sv_number", "riding_code_2026"]].drop_duplicates()

    geolocated = results[~results["is_total_row"] & results["sv_number"].notna()]
    geolocated = geolocated.merge(sv_to_2026, on=["riding_name", "sv_number"], how="left")
    geolocated = geolocated.dropna(subset=["riding_code_2026"])

    per_source_target = geolocated.groupby(["riding_name", "riding_code_2026"])["votes"].sum().rename("target_votes")
    per_source_total = geolocated.groupby("riding_name")["votes"].sum().rename("source_geolocated_votes")
    weights = (per_source_target / per_source_total).rename("weight").reset_index()

    totals = results[results["is_total_row"]][["riding_name", "party_code", "votes"]].rename(columns={"votes": "total_votes"})

    allocated = totals.merge(weights, on="riding_name", how="inner")
    allocated["votes"] = allocated["total_votes"] * allocated["weight"]

    out = allocated.groupby(["riding_code_2026", "party_code"])["votes"].sum().reset_index()
    riding_totals = out.groupby("riding_code_2026")["votes"].transform("sum")
    out["vote_share"] = out["votes"] / riding_totals
    out = out.rename(columns={"riding_code_2026": "riding_code"})
    out["seat_won"] = out.groupby("riding_code")["votes"].transform("max") == out["votes"]
    out["jurisdiction_code"] = jurisdiction_code
    out["election_date"] = election_date
    out["boundary_year"] = "2026"
    return out[
        ["jurisdiction_code", "election_date", "boundary_year", "riding_code", "party_code", "votes", "vote_share", "seat_won"]
    ]


# Elections covered by both a polling-division shapefile (source geometry)
# and the archived bureau-de-vote results -- see SV_SHAPEFILE_URLS.
REPROJECTABLE_ELECTIONS = [
    {"date": "2018-10-01", "sv_year": 2018},
    {"date": "2022-10-03", "sv_year": 2022},
]


def build_all_reprojected_2026_results(raw_dir: Path) -> pd.DataFrame:
    riding_2026_gdf = download_2026_riding_boundaries(raw_dir)
    frames = []
    for spec in REPROJECTABLE_ELECTIONS:
        zip_path = download_bv_results_zip(spec["date"], raw_dir)
        results = parse_bv_results(zip_path)
        sv_gdf = download_sv_boundaries(spec["sv_year"], raw_dir)
        frames.append(
            reproject_results_to_2026(results, sv_gdf, riding_2026_gdf, "qc-provincial", spec["date"])
        )
    return pd.concat(frames, ignore_index=True)
