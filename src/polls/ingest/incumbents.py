"""Each riding's sitting member and their CURRENT party, scraped from
qc125.com's regional pages.

Why this isn't redundant with election_results: a riding's 2022 winner and
its 2026 incumbent-party can differ. Members cross the floor, get expelled,
or sit as independents -- Rosemont is listed as "Vincent Marissal [Élu avec
QS]" with current party "I", so a model that treats Rosemont as a QS seat
being defended has the wrong party defending it. That's the same
candidate-reputation/incumbency question this project opened with, and it
needs the *current* affiliation, not the last election's result.

Table layout on those pages is: Circonscription (riding name + member name
run together), Parti actuel (short code), Projection (qc125's own
qualitative call, deliberately NOT ingested -- this project makes its own
projections and importing theirs would make any comparison circular).
"""

from __future__ import annotations

import io
import re
import unicodedata
from pathlib import Path

import httpx
import pandas as pd

USER_AGENT = "polls-research-bot/0.1 (contact: yysrk9lh@duck.com)"

REGIONAL_PAGES = [
    "abitibinord", "basstlaurentgaspesie", "cantons", "capitalenationale",
    "centremauricie", "chaudiere", "couronnenord", "laval",
    "ll",  # Laurentides-Lanaudière -- the opaque slug made this easy to miss;
           # leaving it out silently dropped 12 ridings from the scrape.
    "monteregieest", "monteregieouest", "mtl", "mtlest", "mtlouest",
    "outaouais", "qc", "saglac",
]

# qc125's short "Parti actuel" codes -> this project's party_code space.
# "I" (independent) and "V" (vacant) deliberately map to themselves rather
# than being forced into a party: an independent-held seat has no party
# incumbency to defend, which is the whole point of collecting this.
CURRENT_PARTY_MAP = {
    "CA": "CAQ",
    "CAQ": "CAQ",
    "L": "LIB",
    "PLQ": "LIB",
    "PQ": "PQ",
    "QS": "QS",
    "PCQ": "PCQ",
    "C": "PCQ",
    "I": "IND",
    "IND": "IND",
    "V": "VACANT",
}


def _strip_accents(text: str) -> str:
    return unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")


def fetch_regional_page(slug: str) -> pd.DataFrame:
    url = f"https://qc125.com/{slug}.htm"
    resp = httpx.get(url, headers={"User-Agent": USER_AGENT}, timeout=30)
    resp.raise_for_status()
    # decode explicitly rather than trusting resp.text: qc125 serves UTF-8
    # but httpx's charset sniffing has already mis-detected it on this site
    # (see ingest/demopoll.py). Wrap in StringIO so pandas doesn't treat the
    # markup as a file path.
    tables = pd.read_html(io.StringIO(resp.content.decode("utf-8", errors="replace")))
    if not tables:
        return pd.DataFrame()
    table = tables[0]
    table.columns = [str(c).strip() for c in table.columns]
    return table


def parse_regional_table(table: pd.DataFrame, riding_names: set[str], region_slug: str) -> pd.DataFrame:
    """The first column packs "<riding name><member name>" with no separator,
    so the riding is recovered by longest-prefix match against the known
    riding list rather than by guessing at a split point."""
    # Strip every non-alphanumeric character, not just spaces and hyphens:
    # riding names carry apostrophes (L'Assomption, D'Arcy-McGee) and the two
    # sources don't always use the same apostrophe glyph, plus qc125 uses
    # en/em dashes where the DGEQ shapefile uses plain hyphens.
    def squash(text: str) -> str:
        return re.sub(r"[^a-z0-9]", "", _strip_accents(text).lower())

    rows = []
    normalized_lookup = {squash(n): n for n in riding_names}

    for _, row in table.iterrows():
        raw = str(row.iloc[0])
        current_party_raw = str(row.iloc[1]).strip().upper()
        squashed = squash(raw)

        matched_name, matched_len = None, 0
        for key, original in normalized_lookup.items():
            if squashed.startswith(key) and len(key) > matched_len:
                matched_name, matched_len = original, len(key)
        if matched_name is None:
            continue

        member = raw[len(matched_name):].strip() if raw.lower().startswith(matched_name.lower()) else None
        if member:
            member = re.sub(r"\[.*?\]", "", member).strip()

        rows.append(
            {
                "riding_name": matched_name,
                "member_name": member or None,
                "current_party": CURRENT_PARTY_MAP.get(current_party_raw, f"AUTRES:{current_party_raw}"),
                "elected_note": (re.search(r"\[(.*?)\]", raw).group(1) if "[" in raw else None),
                "region_slug": region_slug,
            }
        )
    return pd.DataFrame(rows)


# "Élu avec la CAQ" / "Élue avec le PLQ" / "Élu avec QS" -> the party that
# actually won the seat in 2022, which is the one losing its incumbency
# premium now that the member sits elsewhere.
ELECTED_WITH_PATTERNS = [
    (re.compile(r"CAQ", re.I), "CAQ"),
    (re.compile(r"PLQ|lib", re.I), "LIB"),
    (re.compile(r"\bQS\b|solidaire", re.I), "QS"),
    (re.compile(r"\bPQ\b|qu[ée]b[ée]cois", re.I), "PQ"),
    (re.compile(r"PCQ|conservateur", re.I), "PCQ"),
]


def derive_open_seats(incumbents: pd.DataFrame) -> dict[str, str]:
    """Ridings where the party that won in 2022 no longer has its member
    sitting for it: the seat is vacant, or the member now sits as an
    independent / for someone else. Returns {riding_name: party_losing_the_
    incumbency_premium}, feedable straight into
    model/swing.apply_open_seat_adjustment.

    What this does and does not claim: we know the 2022-winning party has no
    sitting incumbent there any more, so its incumbency premium is gone
    regardless of what happens next. We do NOT know whether the departed
    member will run again (as an independent or otherwise) -- that would be
    a separate, and much less certain, personal-vote question.
    """
    open_seats: dict[str, str] = {}
    for _, row in incumbents.iterrows():
        party_now = row["current_party"]
        if party_now not in ("IND", "VACANT") and not str(party_now).startswith("AUTRES"):
            continue
        note = str(row.get("elected_note") or "")
        for pattern, party in ELECTED_WITH_PATTERNS:
            if pattern.search(note):
                open_seats[row["riding_name"]] = party
                break
    return open_seats


# qc125 party pages carry a "Chef" row in a small summary table.
PARTY_PAGE_SLUGS = {"CAQ": "caq", "LIB": "plq", "QS": "qs", "PQ": "pq", "PCQ": "pcq"}
LEADER_ROW_RE = re.compile(r"<td>\s*Chef\s*</td>\s*<td>\s*([^<]+?)\s*</td>", re.I)


def fetch_party_leaders() -> dict[str, str]:
    """{party_code: leader name}, read from qc125's own party pages rather
    than asserted from memory -- party leadership changes, and this project
    has no way to verify a remembered name against the current campaign."""
    leaders = {}
    for party, slug in PARTY_PAGE_SLUGS.items():
        try:
            resp = httpx.get(f"https://qc125.com/{slug}.htm", headers={"User-Agent": USER_AGENT}, timeout=30)
            resp.raise_for_status()
            match = LEADER_ROW_RE.search(resp.content.decode("utf-8", errors="replace"))
            if match:
                leaders[party] = match.group(1).strip()
        except Exception as e:
            print(f"skipping leader lookup for {party}: {e}")
    return leaders


def match_leaders_to_ridings(leaders: dict[str, str], incumbents: pd.DataFrame) -> pd.DataFrame:
    """Join leader names against the scraped sitting-member list to find
    which riding each leader holds. A leader with no match is reported with
    a null riding rather than dropped -- a party leader who doesn't
    currently sit (or who sits under a name spelled differently on the two
    pages) is a real case, and silently omitting them would look like the
    party has no leader at all."""
    def squash(text: str) -> str:
        stripped = _strip_accents(str(text)).lower()
        # "Saint-Pierre-Plamondon" on the party page vs "St-Pierre-Plamondon"
        # in the riding table is the same person; normalize the abbreviation
        # so the join doesn't silently miss a party leader.
        stripped = re.sub(r"\bsaint\b|\bsainte\b", "st", stripped)
        return re.sub(r"[^a-z0-9]", "", stripped)

    by_member = {squash(m): (r, m) for m, r in zip(incumbents["member_name"], incumbents["riding_name"]) if pd.notna(m)}
    rows = []
    for party, leader in leaders.items():
        key = squash(leader)
        match = by_member.get(key)
        if match is None:  # fall back to a containment check for name-order/spelling drift
            match = next((v for k, v in by_member.items() if key and (key in k or k in key)), None)
        rows.append(
            {
                "party_code": party,
                "leader_name": leader,
                "riding_name": match[0] if match else None,
                "matched_member": match[1] if match else None,
            }
        )
    return pd.DataFrame(rows)


def fetch_all_incumbents(riding_names: set[str]) -> pd.DataFrame:
    frames = []
    for slug in REGIONAL_PAGES:
        try:
            table = fetch_regional_page(slug)
            if not table.empty:
                frames.append(parse_regional_table(table, riding_names, slug))
        except Exception as e:
            print(f"skipping region {slug}: {e}")
    if not frames:
        return pd.DataFrame()
    combined = pd.concat(frames, ignore_index=True)
    return combined.drop_duplicates(subset=["riding_name"])
