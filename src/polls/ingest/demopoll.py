"""Scraper for the `window.demopoll_TABLE_DATA` blob embedded server-side on
qc125.com (Quebec provincial) and 338canada.com (federal) polls pages.

Both sites are run by the same author (Philippe J. Fournier / 338Canada) and
share the exact same page template, so a single parser covers both
jurisdictions -- only the base URL and the resulting party codes differ.

The pages render a JS object client-side, but the data itself is inlined as a
JSON literal in the HTML response, so no headless browser is needed.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from datetime import date, datetime, timezone

import httpx
import polars as pl

TABLE_DATA_RE = re.compile(r"window\.demopoll_TABLE_DATA\s*=\s*(\{.*?\});", re.DOTALL)
PARTY_HEADER_RE = re.compile(
    r"<th[^>]*>\s*"
    r'<a href="[^"]*/(?P<slug>[a-z0-9]+)\.htm"[^>]*>'
    r'<img src="(?P<code>[A-Za-z0-9]+)\.svg"'
)

USER_AGENT = "polls-research-bot/0.1 (contact: yysrk9lh@duck.com)"

# qc125.com's own SVG filenames (and hence its embedded JSON's party codes)
# use "CPQ" for the Parti conservateur du Québec; DGEQ (the official source,
# see ingest/dgeq_bureau_vote.py) and Wikipedia use "PCQ", the actual French
# abbreviation. Normalized to PCQ here so poll data and election-result data
# share one party_code space and actually join.
PARTY_CODE_NORMALIZE = {"CPQ": "PCQ"}


@dataclass(frozen=True)
class JurisdictionSource:
    jurisdiction_code: str
    label: str
    source_site: str
    polls_url: str


QC_PROVINCIAL = JurisdictionSource(
    jurisdiction_code="qc-provincial",
    label="Assemblée nationale du Québec",
    source_site="qc125.com",
    polls_url="https://qc125.com/sondages.htm",
)

CA_FEDERAL = JurisdictionSource(
    jurisdiction_code="ca-federal",
    label="Chambre des communes du Canada",
    source_site="338canada.com",
    polls_url="https://338canada.com/polls.htm",
)


def fetch_html(url: str) -> str:
    resp = httpx.get(url, headers={"User-Agent": USER_AGENT}, timeout=30, follow_redirects=True)
    resp.raise_for_status()
    return resp.text


def extract_table_data(html: str) -> dict:
    match = TABLE_DATA_RE.search(html)
    if not match:
        raise ValueError("demopoll_TABLE_DATA not found in page -- site markup may have changed")
    return json.loads(match.group(1))


def extract_party_order(html: str) -> list[str]:
    """Party codes in display order, taken from the first table header block."""
    codes = [PARTY_CODE_NORMALIZE.get(c, c) for c in (m.group("code").upper() for m in PARTY_HEADER_RE.finditer(html))]
    if not codes:
        raise ValueError("could not find party header columns -- site markup may have changed")
    # The header block repeats once per region tab; keep the first distinct run.
    first_run: list[str] = []
    seen: set[str] = set()
    for code in codes:
        if code in seen and first_run and code == first_run[0]:
            break
        if code not in seen:
            first_run.append(code)
            seen.add(code)
    return first_run


def _parse_sample(raw: str | None) -> int | None:
    if not raw:
        return None
    digits = re.sub(r"[^\d]", "", raw)
    return int(digits) if digits else None


def _poll_id(jurisdiction_code: str, region_code: str, firm: str, poll_date: str, sample: str | None) -> str:
    key = f"{jurisdiction_code}|{region_code}|{firm}|{poll_date}|{sample or ''}"
    return hashlib.sha1(key.encode("utf-8")).hexdigest()[:16]


def parse_source(source: JurisdictionSource) -> tuple[pl.DataFrame, pl.DataFrame, list[str]]:
    """Returns (polls_df, poll_shares_df, party_order) for one jurisdiction."""
    html = fetch_html(source.polls_url)
    party_order = extract_party_order(html)
    table_data = extract_table_data(html)
    scraped_at = datetime.now(timezone.utc)

    poll_rows: list[dict] = []
    share_rows: list[dict] = []

    for region_code, region_block in table_data["demos"].items():
        for row in region_block.get("rows", []):
            poll_date_raw = row.get("date") or ""
            if not poll_date_raw:
                continue  # header/placeholder rows without a date
            try:
                poll_date: date = datetime.strptime(poll_date_raw, "%Y-%m-%d").date()
            except ValueError:
                continue

            firm = row.get("firm", "").strip()
            sample_raw = row.get("sample")
            pid = _poll_id(source.jurisdiction_code, region_code, firm, poll_date_raw, sample_raw)

            rating_match = re.search(r">([A-Z+\-]+|NC)<", row.get("ratingbadge", ""))

            # "generalelx" is non-empty on actual election-result rows (the site
            # reuses a CSS class marker there, e.g. "header2", not a usable
            # value) -- normalize to the poll_date itself so the column stays a
            # plain election-date marker instead of a stray CSS token.
            is_actual_result = bool(row.get("generalelx")) or firm == "General election"

            poll_rows.append(
                {
                    "poll_id": pid,
                    "jurisdiction_code": source.jurisdiction_code,
                    "region_code": region_code,
                    "firm": firm,
                    "poll_date": poll_date,
                    "sample_size": _parse_sample(sample_raw),
                    "is_rolling": bool(row.get("isRolling")),
                    "firm_rating": rating_match.group(1) if rating_match else None,
                    "general_election": poll_date_raw if is_actual_result else None,
                    "source_url": row.get("poll_link") or None,
                    "scraped_at": scraped_at,
                }
            )

            cells = row.get("cells", [])
            reported_sum = 0.0
            for code, cell in zip(party_order, cells):
                try:
                    pct = float(cell.get("label", "").replace(",", "."))
                except (TypeError, ValueError):
                    continue
                reported_sum += pct
                share_rows.append({"poll_id": pid, "party_code": code, "pct_reported": pct})

            remainder = round(100.0 - reported_sum, 2)
            if remainder > 0.01:
                share_rows.append({"poll_id": pid, "party_code": "AUTRES", "pct_reported": remainder})

    polls_df = pl.DataFrame(poll_rows, infer_schema_length=None) if poll_rows else pl.DataFrame()
    shares_df = pl.DataFrame(share_rows, infer_schema_length=None) if share_rows else pl.DataFrame()
    return polls_df, shares_df, party_order
