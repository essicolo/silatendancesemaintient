"""SUPERSEDED for the live loop (2026-09-02): the production watcher is the
Deno port, js/ingest/wiki_polls.ts (parity was proven on identical HTML before
the switch, then the harness deleted). This module remains ONLY because the
archival full-rebuild (ingest/run.py) and the next-election recalibration
(model/regional_calibration.py) import it. Do not fix parser bugs here first —
fix them in the TS parser, which is what actually feeds the dashboard.

Poll ingestion from Wikipedia's maintained polling tables.

Replaces the qc125.com scrape as the source of vote-intention polls. Two
reasons, and the second is the one that matters:

  - **Provenance.** qc125 is a competing projection site that compiles polls
    as part of its own product. Taking its compilation to build a rival
    projection, and then not saying so, would be the worst of both worlds.
    Wikipedia's tables are CC BY-SA, explicitly meant for reuse, and each row
    carries a link to the pollster's own release -- so `source_url` points at
    the primary document rather than at an intermediary's copy.
  - **Coverage is better.** Measured, not assumed. Across the three cycle
    pages this yields 538 provincial polls spanning 2014-2026, against 195 in
    the qc125-derived database. For the current cycle the two sources carry
    essentially the same polls: a side-by-side match on firm and sample size
    shows them pairing one-for-one with dates offset by exactly one day (the
    two sites use different date conventions -- last field day vs. release).
    Each source has a handful the other lacks; Wikipedia was also one day
    fresher at the time of the switch.

Because of that one-day offset the poll_id hashes do NOT line up between the
two sources, so this is a replacement rather than a merge -- running both
would double-count nearly every poll. The id scheme is kept identical anyway
so that re-ingesting the same Wikipedia page twice is idempotent.

What is lost: qc125's regional subsamples (Montreal / Quebec City / rest of
province) and its editorial pollster ratings. Neither is used by the live
model -- only the National series is exported, and the rating's measured
contribution to aggregation accuracy was 0.01pp. A missing rating falls back
to a constant weight, which after normalisation is the same as no rating
weighting at all.

Column layout differs between cycles (2018 lists PQ before QS and carries a
PVQ column that later years drop), so parsing is driven by column NAMES, never
by position.

"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from dataclasses import dataclass
from datetime import date, datetime

import httpx
import lxml.html
import polars as pl

USER_AGENT = "polls-research-bot/0.1 (contact: yysrk9lh@duck.com; Quebec election forecasting project)"
API = "https://fr.wikipedia.org/w/api.php"

POLL_PAGES: dict[str, str] = {
    "2026": "Liste de sondages sur les élections générales québécoises de 2026",
    "2022": "Liste de sondages sur les élections générales québécoises de 2022",
    "2018": "Liste de sondages sur les élections générales québécoises de 2018",
}

# Wikipedia's column headers -> our party codes. PVQ (Green) appears only in
# the 2018 table and is folded into AUTRES rather than given a code of its
# own: it is absent from every other cycle, and a party present in one
# election and structurally missing in the next cannot be carried as its own
# part of the composition.
PARTY_COLUMNS = {
    "CAQ": "CAQ",
    "PLQ": "LIB",
    "QS": "QS",
    "PQ": "PQ",
    "PCQ": "PCQ",
    "CQ": "PCQ",
    "PVQ": "AUTRES",
    "Autres": "AUTRES",
}

# Wikipedia abbreviates; the database already holds these spellings from the
# previous source. Normalising here keeps poll_id stable across the switch.
FIRM_NORMALIZE = {
    "Mainstreet": "Mainstreet Research",
    "Pallas": "Pallas Data",
    "Liaison": "Liaison Strategies",
    "Innovative": "Innovative Research",
    "Synopsis": "Synopsis Recherche",
    "Synopsis / La Presse": "Synopsis Recherche",
    "Segma": "Segma Recherche",
    "Research Co": "Research Co.",
    "Forum": "Forum Research",
}

MONTHS = {
    "janvier": 1, "février": 2, "fevrier": 2, "mars": 3, "avril": 4, "mai": 5,
    "juin": 6, "juillet": 7, "août": 8, "aout": 8, "septembre": 9,
    "octobre": 10, "novembre": 11, "décembre": 12, "decembre": 12,
}


@dataclass(frozen=True)
class PageSnapshot:
    """A fetched page plus the revision id that identifies it. The revision id
    is what makes a cheap watch possible: one small API call tells you whether
    anything changed at all, without re-downloading or re-parsing 380 KB."""

    title: str
    revid: int
    html: str


def latest_revision(title: str) -> int:
    resp = httpx.get(
        API,
        params={"action": "query", "prop": "revisions", "titles": title, "rvprop": "ids", "format": "json"},
        headers={"User-Agent": USER_AGENT},
        timeout=30,
    )
    resp.raise_for_status()
    pages = resp.json()["query"]["pages"]
    page = next(iter(pages.values()))
    if "revisions" not in page:
        raise LookupError(f"page introuvable sur fr.wikipedia : {title}")
    return int(page["revisions"][0]["revid"])


def fetch_page(title: str) -> PageSnapshot:
    # Revision id BEFORE the HTML, not after. The other order has a race: an
    # edit landing between the two requests records a revid whose content was
    # never parsed, and any poll in that edit is silently missed until the
    # page is edited again. This order errs the safe way -- an edit in the gap
    # makes the stored revid stale, so the next watch run re-examines it.
    revid = latest_revision(title)
    url = f"https://fr.wikipedia.org/wiki/{title.replace(' ', '_')}"
    resp = httpx.get(url, headers={"User-Agent": USER_AGENT}, timeout=60, follow_redirects=True)
    resp.raise_for_status()
    # Decode explicitly: httpx's charset sniffing has mis-guessed on these
    # pages before, and a mis-decoded "août" silently kills date parsing.
    return PageSnapshot(title=title, revid=revid, html=resp.content.decode("utf-8"))


def _parse_date(text: str) -> date | None:
    text = re.sub(r"\[.*?\]", "", text).strip().lower().replace("\xa0", " ")
    m = re.search(r"(\d{1,2})\s+([a-zéûôà]+)\s+(\d{4})", text)
    if not m:
        return None
    month = MONTHS.get(m.group(2))
    return date(int(m.group(3)), month, int(m.group(1))) if month else None


def _parse_number(text: str) -> float | None:
    """Cells carry footnote markers, thin spaces, commas as decimal separators
    and occasional en-dashes for "not asked"."""
    text = re.sub(r"\[.*?\]", "", str(text)).replace("\xa0", "").replace(" ", "").replace(" ", "")
    text = text.replace(",", ".").replace("%", "").replace("±", "")
    m = re.search(r"-?\d+(?:\.\d+)?", text)
    return float(m.group()) if m else None


def _normalize_firm(text: str) -> str:
    text = re.sub(r"\[.*?\]", "", text).strip()
    text = re.sub(r"\s*/\s*La Presse$", "", text)
    return FIRM_NORMALIZE.get(text, text)


def _poll_id(jurisdiction_code: str, region_code: str, firm: str, poll_date: str, sample: str | None) -> str:
    key = f"{jurisdiction_code}|{region_code}|{firm}|{poll_date}|{sample or ''}"
    return hashlib.sha1(key.encode("utf-8")).hexdigest()[:16]


# The cycle pages do not only carry province-wide polls. They also publish
# the same pollsters' SUBGROUP breakdowns -- by language, by region, by age --
# in tables with identical columns. Reading those as province-wide numbers put
# the Liberals at 80% in 2015 (that is the non-francophone subsample) and
# inflated the series with rows that are not what they claim to be.
#
# The subgroup is never in the table; it is in the section heading above it.
# So tables are located by walking the document in order and keeping the
# heading chain, then rejecting any table sitting under a breakdown heading.
BREAKDOWN_PATTERNS = (
    "par langue",
    "par region",
    "par age",
    "par sexe",
    "par groupe",
    "francophone",
    "chez les",
    "ile de montreal",
    "region metropolitaine",
    "capitale-nationale",
    "reste du quebec",
)


def _strip_accents(text: str) -> str:
    return unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")


def _is_breakdown(headings: list[str]) -> bool:
    joined = _strip_accents(" / ".join(headings)).lower()
    return any(pattern in joined for pattern in BREAKDOWN_PATTERNS)


def _tables_with_headings(doc):
    """Yield (table, heading_chain) in document order, the chain being the
    current h2/h3/h4 above the table."""
    chain: dict[int, str] = {}
    for node in doc.xpath("//h2|//h3|//h4|//table"):
        tag = node.tag.lower()
        if tag in ("h2", "h3", "h4"):
            level = int(tag[1])
            chain[level] = _clean_heading(node.text_content())
            for deeper in [k for k in chain if k > level]:
                del chain[deeper]
        else:
            yield node, [chain[k] for k in sorted(chain)]


def _clean_heading(text: str) -> str:
    return re.sub(r"\s+", " ", text.replace("[modifier | modifier le code]", "")).strip()


def _cell_text(cell) -> str:
    return cell.text_content().strip()


def _cell_link(cell) -> str | None:
    """First external link in the cell -- the pollster's own release."""
    for href in cell.xpath(".//a/@href"):
        if href.startswith("http") and "wikipedia.org" not in href and "wikimedia.org" not in href:
            return href
    return None


def parse_polls(snapshot: PageSnapshot, jurisdiction_code: str = "qc-provincial") -> tuple[pl.DataFrame, pl.DataFrame]:
    """Returns (polls, poll_shares). Rows that are not polls -- the tables
    interleave narrative event rows like "14 janvier 2026: Annonce de la
    démission de François Legault" -- are dropped by requiring both a
    parseable date and at least two numeric party cells."""
    doc = lxml.html.fromstring(snapshot.html)
    poll_rows: list[dict] = []
    share_rows: list[dict] = []
    seen: set[str] = set()
    skipped: list[tuple[str, int]] = []

    for table, headings in _tables_with_headings(doc):
        headers = [_cell_text(th) for th in table.xpath(".//tr[1]/th")]
        if "Sondeur" not in headers or "CAQ" not in headers:
            continue
        if _is_breakdown(headings):
            skipped.append((headings[-1] if headings else "?", len(table.xpath(".//tr")) - 1))
            continue
        idx = {name: i for i, name in enumerate(headers)}
        party_idx = {headers[i]: i for i in range(len(headers)) if headers[i] in PARTY_COLUMNS}

        for tr in table.xpath(".//tr"):
            cells = tr.xpath("./td")
            if len(cells) < len(headers) - 2:
                continue

            poll_date = _parse_date(_cell_text(cells[0]))
            if poll_date is None:
                continue

            shares: dict[str, float] = {}
            for col, i in party_idx.items():
                if i >= len(cells):
                    continue
                value = _parse_number(_cell_text(cells[i]))
                if value is None:
                    continue
                code = PARTY_COLUMNS[col]
                shares[code] = shares.get(code, 0.0) + value
            if len(shares) < 2:
                continue

            firm_i = idx["Sondeur"]
            if firm_i >= len(cells):
                continue
            firm = _normalize_firm(_cell_text(cells[firm_i]))
            if not firm:
                continue

            sample = None
            if "Échantillon" in idx and idx["Échantillon"] < len(cells):
                raw = _parse_number(_cell_text(cells[idx["Échantillon"]]))
                sample = int(raw) if raw and raw > 0 else None

            source_url = None
            if "Source" in idx and idx["Source"] < len(cells):
                source_url = _cell_link(cells[idx["Source"]])

            pid = _poll_id(jurisdiction_code, "National", firm, poll_date.isoformat(), str(sample) if sample else None)
            if pid in seen:
                continue
            seen.add(pid)

            poll_rows.append(
                {
                    "poll_id": pid,
                    "jurisdiction_code": jurisdiction_code,
                    "region_code": "National",
                    "firm": firm,
                    "poll_date": poll_date,
                    "sample_size": sample,
                    "is_rolling": False,
                    "firm_rating": None,
                    "general_election": None,
                    "source_url": source_url or f"https://fr.wikipedia.org/wiki/{snapshot.title.replace(' ', '_')}",
                    "scraped_at": datetime.now(),
                }
            )
            for code, pct in shares.items():
                share_rows.append({"poll_id": pid, "party_code": code, "pct_reported": pct})

    if skipped:
        # Announce what was dropped: a silent filter looks identical to a
        # source that never had those tables.
        detail = ", ".join(f"{name} ({n})" for name, n in skipped)
        print(f"    sous-groupes ignores : {detail}")

    polls = pl.DataFrame(poll_rows, infer_schema_length=None) if poll_rows else pl.DataFrame()
    shares = pl.DataFrame(share_rows, infer_schema_length=None) if share_rows else pl.DataFrame()
    return polls, shares


def fetch_all(cycles: list[str] | None = None) -> tuple[pl.DataFrame, pl.DataFrame, dict[str, int]]:
    """All configured cycles, concatenated, plus the revision id seen for
    each page so a watcher can record what it has already processed."""
    frames_p, frames_s, revs = [], [], {}
    for cycle in cycles or list(POLL_PAGES):
        snapshot = fetch_page(POLL_PAGES[cycle])
        polls, shares = parse_polls(snapshot)
        revs[cycle] = snapshot.revid
        if len(polls):
            frames_p.append(polls)
            frames_s.append(shares)

    polls = pl.concat(frames_p, how="diagonal").unique(subset=["poll_id"], keep="first") if frames_p else pl.DataFrame()
    shares = pl.concat(frames_s, how="diagonal").unique(subset=["poll_id", "party_code"]) if frames_s else pl.DataFrame()
    return polls, shares, revs


REVISION_TABLE = "source_revisions"


def record_revisions(con, revisions: dict[str, int]) -> None:
    con.execute(
        f"CREATE TABLE IF NOT EXISTS {REVISION_TABLE} "
        "(source VARCHAR PRIMARY KEY, revid BIGINT, checked_at TIMESTAMP)"
    )
    for cycle, revid in revisions.items():
        con.execute(f"DELETE FROM {REVISION_TABLE} WHERE source = ?", [f"wiki_qc_{cycle}"])
        con.execute(f"INSERT INTO {REVISION_TABLE} VALUES (?, ?, now())", [f"wiki_qc_{cycle}", revid])


def known_revisions(con) -> dict[str, int]:
    """Revision ids already processed, keyed by cycle. Empty when the table
    doesn't exist yet, which makes the first watch run a full ingest."""
    try:
        rows = con.execute(f"SELECT source, revid FROM {REVISION_TABLE}").fetchall()
    except Exception:
        return {}
    return {s.removeprefix("wiki_qc_"): int(r) for s, r in rows if s.startswith("wiki_qc_")}


def ingest_qc_polls(con, cycles: list[str] | None = None) -> tuple[int, dict[str, int]]:
    """Fetch, load and record revisions. Replaces the provincial poll series
    wholesale: the previous source dated polls one day differently, so leaving
    its rows in place would double-count almost every poll."""
    from polls.db.load import upsert_jurisdiction, upsert_parties, upsert_poll_shares, upsert_polls, upsert_regions

    polls, shares, revisions = fetch_all(cycles)

    upsert_jurisdiction(con, "qc-provincial", "Québec (provincial)", "fr.wikipedia.org")
    upsert_parties(con, "qc-provincial", ["CAQ", "LIB", "QS", "PQ", "PCQ", "AUTRES"])
    upsert_regions(con, "qc-provincial", ["National"])

    # Replace ONLY the National series this source provides. Regional rows
    # (MTL/QC/REG) come from other loaders -- Léger's regional cumulation,
    # report PDFs -- and a blanket jurisdiction-wide delete silently destroyed
    # them on every watch run.
    con.execute(
        "DELETE FROM poll_shares WHERE poll_id IN "
        "(SELECT poll_id FROM polls WHERE jurisdiction_code = 'qc-provincial' AND region_code = 'National')"
    )
    con.execute("DELETE FROM polls WHERE jurisdiction_code = 'qc-provincial' AND region_code = 'National'")

    upsert_polls(con, polls)
    upsert_poll_shares(con, shares)
    record_revisions(con, revisions)
    return len(polls), revisions


if __name__ == "__main__":
    polls, shares, revs = fetch_all()
    print(f"{len(polls)} sondages, {len(shares)} parts, revisions {revs}")
    print(polls.sort("poll_date", descending=True).head(8).to_pandas().to_string())
