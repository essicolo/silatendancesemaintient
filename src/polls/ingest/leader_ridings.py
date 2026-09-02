"""Where each party leader is actually running.

The dashboard previously showed a leader's *current seat*, found by looking
their name up in the list of sitting members. A leader who holds no seat fell
through as "ne siège pas" and got no projection at all -- which confuses two
different things. Not holding a seat today says nothing about whether a
riding can be projected; what the table needs is the riding the leader is
CONTESTING in 2026, and that exists whether or not they sit now.

For sitting leaders running again in the same riding the two coincide. They
diverge exactly where it matters: a leader elected between elections, a
leader switching ridings, and a leader with no seat at all.

Wikipedia carries this in prose, not in a table ("Le 27 mai 2026, Éric
Duhaime annonce officiellement sa candidature dans la circonscription de
Bellechasse"). Free-text extraction is fragile, so it is fenced three ways:

  1. a candidacy cue phrase must appear;
  2. the election year must appear in the same window, otherwise the leader's
     earlier runs get picked up -- Duhaime's article names Deux-Montagnes
     (2003) and Arthabaska (2025) long before it names Bellechasse;
  3. the extracted name must match an actual riding on the 2026 map. Nothing
     is invented: an unrecognised string is discarded rather than guessed at.

If no announcement is found the caller keeps the current seat, and if there
is neither, the honest display is "circonscription non annoncée" -- an
unknown, not an impossibility.
"""

from __future__ import annotations

import re
import unicodedata

import httpx
import lxml.html

USER_AGENT = "polls-research-bot/0.1 (contact: yysrk9lh@duck.com; Quebec election forecasting project)"

CANDIDACY_CUES = (
    "candidature",
    "briguera",
    "brigue",
    "se présenter",
    "se présente",
    "candidat dans",
    "candidate dans",
)
WINDOW = 400


def _strip_accents(text: str) -> str:
    return unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")


def _key(text: str) -> str:
    """Comparison key for people and place names. Sources disagree on
    apostrophe glyph, dash type, and whether Saint is spelled out -- "Paul
    St-Pierre Plamondon" and "Paul Saint-Pierre-Plamondon" are the same
    person, and comparing them raw silently loses a party leader."""
    key = _strip_accents(text).lower()
    key = re.sub(r"\bsainte\b", "ste", key)
    key = re.sub(r"\bsaint\b", "st", key)
    return re.sub(r"[^a-z0-9]", "", key)


def fetch_article_text(name: str) -> str | None:
    url = f"https://fr.wikipedia.org/wiki/{name.replace(' ', '_')}"
    try:
        resp = httpx.get(url, headers={"User-Agent": USER_AGENT}, timeout=30, follow_redirects=True)
        if resp.status_code != 200:
            return None
    except Exception:
        return None
    doc = lxml.html.fromstring(resp.content.decode("utf-8"))
    return re.sub(r"\s+", " ", doc.text_content())


def find_announced_riding(text: str, riding_names: set[str], election_year: str = "2026") -> str | None:
    """The riding named closest after a candidacy cue, within a window that
    also mentions the election year."""
    if not text:
        return None

    # Longest first: "Chutes-de-la-Chaudière" must not be shadowed by a
    # shorter riding whose name is a substring of another.
    ordered = sorted(riding_names, key=len, reverse=True)
    lowered = _strip_accents(text).lower()

    best: tuple[int, str] | None = None
    for cue in CANDIDACY_CUES:
        for match in re.finditer(_strip_accents(cue).lower(), lowered):
            window = lowered[match.start() : match.start() + WINDOW]
            if election_year not in window:
                continue
            for riding in ordered:
                pos = window.find(_strip_accents(riding).lower())
                if pos >= 0 and (best is None or pos < best[0]):
                    best = (pos, riding)
    return best[1] if best else None


def resolve_leader_ridings(
    leaders: list[dict],
    riding_names: set[str],
    election_year: str = "2026",
    incumbents: list[dict] | None = None,
) -> list[dict]:
    """Adds `riding_name` (the riding contested at the coming election) and
    `riding_source` to each leader.

    `riding_source` records how it was determined -- "annonce" for a confirmed
    candidacy, "siege actuel" for the assumption that a sitting leader runs
    again where they sit -- so a reader can tell a fact from an assumption.

    The fallback to the current seat is resolved here rather than trusted from
    the caller, because the leader list and the members list come from
    different sources that spell names differently.
    """
    seat_by_member = {}
    for row in incumbents or []:
        if row.get("member_name") and row.get("riding_name"):
            seat_by_member[_key(row["member_name"])] = row["riding_name"]

    out = []
    for leader in leaders:
        entry = dict(leader)
        announced = find_announced_riding(
            fetch_article_text(entry["leader_name"]) or "", riding_names, election_year
        )
        seat = seat_by_member.get(_key(entry["leader_name"])) or (
            entry["riding_name"] if isinstance(entry.get("riding_name"), str) else None
        )

        if announced:
            entry["riding_name"] = announced
            entry["riding_source"] = "annonce"
        elif seat:
            entry["riding_name"] = seat
            entry["riding_source"] = "siege actuel"
        else:
            entry["riding_name"] = None
            entry["riding_source"] = None
        out.append(entry)
    return out


if __name__ == "__main__":
    import duckdb

    con = duckdb.connect("data/polls.duckdb", read_only=True)
    ridings = set(con.execute("SELECT DISTINCT riding_name FROM incumbents").df()["riding_name"])
    leaders = con.execute(
        "SELECT party_code, leader_name, riding_name FROM party_leaders WHERE jurisdiction_code='qc-provincial'"
    ).df().to_dict("records")
    for row in resolve_leader_ridings(leaders, ridings):
        print(f"{row['party_code']:5s} {_strip_accents(row['leader_name']):28s} "
              f"{_strip_accents(str(row['riding_name'])):26s} {row['riding_source']}")
