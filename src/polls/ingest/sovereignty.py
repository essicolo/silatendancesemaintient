"""Quebec sovereignty-referendum-question polling (qc125.com/sondages-souv.htm),
same embedded-JSON structure as the main vote-intention page (demopoll.py)
but keyed by demographic subgroup instead of geographic region: age bracket,
gender, and francophone/non-francophone -- exactly the age-cohort
breakdown the main vote-intention polls don't have.

Stored as a separate jurisdiction_code ("qc-sovereignty") reusing the
existing polls/poll_shares/parties/regions tables: "parties" here are the
referendum options (OUI/NON/INDECIS, not electoral parties) and "regions"
are demographic subgroup codes (q=whole province, m/f=gender, age1-3=age
brackets, FR/NF=language) rather than geography -- a deliberate reuse of an
existing column rather than a schema change, since the shape (one poll x
one cross-tab slice x N options) is identical.

The header markup here has no <a> wrapping the party-option <img> (unlike
the vote-intention page), so this needs its own party-order extraction
rather than demopoll.py's PARTY_HEADER_RE.
"""

from __future__ import annotations

import re
from datetime import datetime

import polars as pl

from polls.ingest.demopoll import USER_AGENT, extract_table_data, fetch_html, _parse_sample, _poll_id

SOVEREIGNTY_URL = "https://qc125.com/sondages-souv.htm"
JURISDICTION_CODE = "qc-sovereignty"

OPTION_HEADER_RE = re.compile(r'<img src="qc-([a-z]+)\.svg"')

# qc125's short subgroup keys -> a readable label, kept as the region_code
# value itself (region_code stays machine-readable; label is for display).
SEGMENT_LABELS = {
    "q": "Ensemble du Québec",
    "m": "Hommes",
    "f": "Femmes",
    "age1": "18-34 ans",
    "age2": "35-54 ans",
    "age3": "55 ans et plus",
    "FR": "Francophones",
    "NF": "Non-francophones",
}


def extract_option_order(html: str) -> list[str]:
    codes = [m.group(1).upper() for m in OPTION_HEADER_RE.finditer(html)]
    seen, first_run = set(), []
    for code in codes:
        if code in seen and first_run and code == first_run[0]:
            break
        if code not in seen:
            first_run.append(code)
            seen.add(code)
    if not first_run:
        raise ValueError("could not find OUI/NON/IND header columns -- site markup may have changed")
    return first_run


def parse_sovereignty_polls() -> tuple[pl.DataFrame, pl.DataFrame, list[str]]:
    html = fetch_html(SOVEREIGNTY_URL)
    option_order = extract_option_order(html)  # e.g. ["NON", "OUI", "IND"]
    table_data = extract_table_data(html)
    scraped_at = datetime.now()

    poll_rows: list[dict] = []
    share_rows: list[dict] = []

    for segment_code, segment_block in table_data["demos"].items():
        for row in segment_block.get("rows", []):
            poll_date_raw = row.get("date") or ""
            if not poll_date_raw:
                continue
            try:
                poll_date = datetime.strptime(poll_date_raw, "%Y-%m-%d").date()
            except ValueError:
                continue

            firm = row.get("firm", "").strip()
            sample_raw = row.get("sample")
            pid = _poll_id(JURISDICTION_CODE, segment_code, firm, poll_date_raw, sample_raw)

            rating_match = re.search(r">([A-Z+\-]+|NC)<", row.get("ratingbadge", ""))

            poll_rows.append(
                {
                    "poll_id": pid,
                    "jurisdiction_code": JURISDICTION_CODE,
                    "region_code": segment_code,
                    "firm": firm,
                    "poll_date": poll_date,
                    "sample_size": _parse_sample(sample_raw),
                    "is_rolling": bool(row.get("isRolling")),
                    "firm_rating": rating_match.group(1) if rating_match else None,
                    "general_election": None,
                    "source_url": row.get("poll_link") or None,
                    "scraped_at": scraped_at,
                }
            )

            cells = row.get("cells", [])
            for code, cell in zip(option_order, cells):
                try:
                    pct = float(cell.get("label", "").replace(",", "."))
                except (TypeError, ValueError):
                    continue
                share_rows.append({"poll_id": pid, "party_code": code, "pct_reported": pct})

    polls_df = pl.DataFrame(poll_rows, infer_schema_length=None) if poll_rows else pl.DataFrame()
    shares_df = pl.DataFrame(share_rows, infer_schema_length=None) if share_rows else pl.DataFrame()
    return polls_df, shares_df, option_order
