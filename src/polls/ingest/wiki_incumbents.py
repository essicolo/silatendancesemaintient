"""Sitting members, party leaders and retirements, from Wikipedia.

The 43rd legislature has 125 ridings; the 2026 map has 127. Six were renamed
(RENAMES_2026 below) and two are new (Bellefeuille, Marie-Lacoste-Gérin-
Lajoie) -- the new ones have no incumbent, which the projection treats as
"no personal vote to protect" rather than as an open-seat penalty: their
baseline is already a reprojected blend of several members' former territory,
so no single candidate's personal vote is in it.


Replaces the qc125.com scrape for the same reason as wiki_polls.py: the
provenance of a competing projection site's compiled pages is the wrong
foundation for this project, and Wikipedia's tables are licensed for reuse.

Three tables, two pages:

  - **43e législature du Québec** -- every seat with its member and party.
    Richer than the previous source, because it records mid-term party
    changes as separate dated rows ("Coalition avenir (2022-2025)" followed
    by "Indépendant (2025-)"). The current party is the LAST row for a
    riding, and the presence of more than one row is itself the signal that
    the seat changed hands between elections.
  - **Élections générales québécoises de 2026 / Députés ne se représentant
    pas** -- the members standing down. This is what the incumbency
    adjustment needs: a seat whose member is not running loses the personal
    vote the previous result was built on.
  - the same page's party summary table -- each party's candidate for
    premier, i.e. its leader.

Retirement lists are maintained by hand and lag reality, so a member missing
from it is treated as running, not as unknown. That errs toward leaving the
incumbency bonus in place, which is the conservative direction: it keeps the
projection closer to the last actual result rather than inventing a swing.
"""

from __future__ import annotations

import re
import unicodedata
from datetime import datetime

import httpx
import lxml.html
import pandas as pd

USER_AGENT = "polls-research-bot/0.1 (contact: yysrk9lh@duck.com; Quebec election forecasting project)"
LEGISLATURE_PAGE = "43e législature du Québec"
ELECTION_PAGE = "Élections générales québécoises de 2026"

# Wikipedia spells parties out, in several variants depending on the table.
# Matched longest-first so "Parti conservateur du Québec" cannot be captured
# by a bare "Parti québécois" substring test.
PARTY_PATTERNS: list[tuple[str, str]] = [
    ("coalition avenir", "CAQ"),
    ("parti liberal", "LIB"),
    ("liberal", "LIB"),
    ("quebec solidaire", "QS"),
    ("solidaire", "QS"),
    ("parti conservateur", "PCQ"),
    ("conservateur", "PCQ"),
    ("parti quebecois", "PQ"),
    ("quebecois", "PQ"),
    ("independant", "IND"),
    ("vacant", "VACANT"),
]


def _strip_accents(text: str) -> str:
    return unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")


def _clean(text: str) -> str:
    """Drop footnote markers and normalise whitespace, including the
    non-breaking spaces Wikipedia uses freely."""
    text = re.sub(r"\[\s*\d+\s*\]|\[[a-z]\]", "", text)
    return re.sub(r"\s+", " ", text.replace("\xa0", " ")).strip()


def _party_code(text: str) -> str | None:
    key = _strip_accents(_clean(text)).lower()
    for pattern, code in PARTY_PATTERNS:
        if pattern in key:
            return code
    return None


def _fetch(title: str) -> lxml.html.HtmlElement:
    url = f"https://fr.wikipedia.org/wiki/{title.replace(' ', '_')}"
    resp = httpx.get(url, headers={"User-Agent": USER_AGENT}, timeout=60, follow_redirects=True)
    resp.raise_for_status()
    return lxml.html.fromstring(resp.content.decode("utf-8"))


def _expand_rows(table, headers: list[str]) -> list[dict[str, str]]:
    """Read a table honouring rowspan.

    Needed, not cosmetic: the legislature table gives a member who changed
    party two rows, with the member and riding cells spanning both and only
    the party cell repeated. Reading rows naively drops every second row --
    which silently reproduced the 2022 election result as if it were the
    current standing, complete with zero independents.
    """
    carry: dict[int, tuple[str, int]] = {}
    out: list[dict[str, str]] = []

    for tr in table.xpath(".//tr"):
        cells = tr.xpath("./td")
        if not cells:
            continue

        row: list[str] = []
        it = iter(cells)
        for col in range(len(headers)):
            if col in carry:
                text, remaining = carry[col]
                row.append(text)
                if remaining <= 1:
                    del carry[col]
                else:
                    carry[col] = (text, remaining - 1)
                continue
            cell = next(it, None)
            if cell is None:
                row.append("")
                continue
            text = _clean(cell.text_content())
            row.append(text)
            span = int(cell.get("rowspan") or 1)
            if span > 1:
                carry[col] = (text, span - 1)

        out.append(dict(zip(headers, row)))
    return out


def _find_table(doc, required: set[str]):
    for table in doc.xpath("//table"):
        headers = {_clean(th.text_content()) for th in table.xpath(".//tr[1]//th")}
        if required <= headers:
            return table, [_clean(th.text_content()) for th in table.xpath(".//tr[1]//th")]
    raise LookupError(f"aucun tableau avec les colonnes {required}")


def fetch_incumbents() -> pd.DataFrame:
    """One row per riding: member, current party, and whether the seat changed
    party mid-term."""
    doc = _fetch(LEGISLATURE_PAGE)
    table, headers = _find_table(doc, {"Député", "Parti", "Circonscription"})

    rows: list[dict] = []
    for record in _expand_rows(table, headers):
        riding, member, party_raw = record["Circonscription"], record["Député"], record["Parti"]
        if not riding or not party_raw:
            continue
        code = _party_code(party_raw)
        if code is None:
            continue
        rows.append({"riding_name": riding, "member_name": member, "current_party": code})

    df = pd.DataFrame(rows)
    if df.empty:
        return df

    # Last row per riding wins: it is the standing arrangement. A riding with
    # more than one row changed party since 2022.
    changed = df.groupby("riding_name").size() > 1
    latest = df.groupby("riding_name", as_index=False).last()
    latest["party_changed_midterm"] = latest["riding_name"].map(changed)
    return latest


def fetch_not_running() -> pd.DataFrame:
    """Members standing down at the next election."""
    doc = _fetch(ELECTION_PAGE)
    table, headers = _find_table(doc, {"Nom", "Circonscription", "Fonction"})
    idx = {name: i for i, name in enumerate(headers)}

    rows = []
    for tr in table.xpath(".//tr"):
        cells = tr.xpath("./td")
        if len(cells) < len(headers) - 1:
            continue
        offset = len(headers) - len(cells)
        riding = _clean(cells[idx["Circonscription"] - offset].text_content())
        name = _clean(cells[idx["Nom"] - offset].text_content())
        if riding:
            rows.append({"riding_name": riding, "member_name": name})
    return pd.DataFrame(rows)


def fetch_party_leaders() -> pd.DataFrame:
    """{party_code, leader_name} from the election page's party summary."""
    doc = _fetch(ELECTION_PAGE)
    for table in doc.xpath("//table"):
        headers = [_clean(th.text_content()) for th in table.xpath(".//tr//th")]
        joined = " ".join(headers)
        if "Parti politique" not in joined or "premier" not in joined.lower():
            continue
        leader_col = next((i for i, h in enumerate(headers) if "premier" in h.lower()), None)
        rows = []
        for tr in table.xpath(".//tr"):
            cells = tr.xpath("./td")
            if len(cells) < 3:
                continue
            code = _party_code(cells[0].text_content())
            if code is None:
                continue
            # Header rows repeat inside these tables; the leader cell sits at
            # the same offset as in the header once the label column is
            # accounted for.
            candidates = [_clean(c.text_content()) for c in cells]
            leader = candidates[leader_col] if leader_col is not None and leader_col < len(candidates) else None
            if leader:
                rows.append({"party_code": code, "leader_name": leader})
        if rows:
            return pd.DataFrame(rows).drop_duplicates(subset=["party_code"])
    raise LookupError("tableau des chefs introuvable")


# 43rd-legislature name -> 2026-map name, for the six redistricting renames.
# Applied via _match_key so accent/dash/apostrophe variants still land.
RENAMES_2026 = {
    "Arthabaska": "Arthabaska-L'Érable",
    "Johnson": "Daniel-Johnson",
    "Laporte": "Pierre-Laporte",
    "Matane-Matapédia": "Matane-Matapédia-Mitis",
    "Rivière-du-Loup–Témiscouata": "Rivière-du-Loup–Témiscouata–Les Basques",
    "Vimont": "Vimont-Auteuil",
}


def _match_key(name: str) -> str:
    """Riding names differ in apostrophe glyph, dash type and Saint/St
    abbreviation between sources; comparing on alphanumerics only sidesteps
    all three."""
    return re.sub(r"[^a-z0-9]", "", _strip_accents(name).lower())


def build(riding_names: set[str]) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Returns (incumbents, leaders) aligned to the 2026 riding names."""
    incumbents = fetch_incumbents()
    not_running = fetch_not_running()
    leaders = fetch_party_leaders()

    standing_down = {_match_key(r) for r in not_running["riding_name"]}
    incumbents["key"] = incumbents["riding_name"].map(_match_key)
    incumbents["is_running"] = ~incumbents["key"].isin(standing_down)

    # An open seat is one whose member is standing down OR whose party changed
    # mid-term: in both cases the previous result's personal vote is gone.
    incumbents["elected_note"] = incumbents.apply(
        lambda r: "ne se represente pas" if not r["is_running"] else ("changement de parti" if r["party_changed_midterm"] else None),
        axis=1,
    )

    # Redistricting renames first, so "Arthabaska" resolves to the 2026 map's
    # "Arthabaska-L'Érable" rather than falling through unmatched.
    rename_by_key = {_match_key(old): new for old, new in RENAMES_2026.items()}
    incumbents["key"] = incumbents["key"].map(lambda k: _match_key(rename_by_key[k]) if k in rename_by_key else k)

    by_key = {_match_key(n): n for n in riding_names}
    incumbents["riding_name"] = incumbents["key"].map(by_key).fillna(incumbents["riding_name"])

    leaders["riding_name"] = leaders["leader_name"].map(
        lambda name: next(
            (r["riding_name"] for _, r in incumbents.iterrows() if _match_key(r["member_name"]) == _match_key(name)),
            None,
        )
    )
    return incumbents[["riding_name", "member_name", "current_party", "elected_note"]], leaders


if __name__ == "__main__":
    inc, led = build(set())
    print(f"{len(inc)} circonscriptions")
    print(inc["current_party"].value_counts().to_string())
    print(f"\nsieges ouverts : {inc['elected_note'].notna().sum()}")
    print(inc["elected_note"].value_counts().to_string())
    print(f"\n{len(led)} chefs")
    print(led.to_string())
