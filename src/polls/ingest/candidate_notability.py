"""Candidate prominence ("candidat vedette") as a riding-level predictor.

The first pass at this in the project tested national Wikipedia pageviews
for a single party leader against national vote shares, found the raw
correlation vanished under differencing, and dropped the idea. That test
answered a different question than the one worth asking: whether a
PARTICULAR CANDIDATE's prominence moves THEIR OWN riding away from the
provincial swing.

Two signals, in increasing order of how much they assume:

  - **Has an article at all.** Wikipedia notability is a crude but genuine
    threshold: a candidate with an article was publicly known for something
    before the campaign. It's binary, cheap, and available for every
    candidate.
  - **Pageviews around the election.** Continuous prominence among those who
    clear that bar. Noisier -- an article can spike for reasons unrelated to
    the campaign -- and only defined for the subset with articles.

Both are proxies for notability, not for being *liked*: a candidate can be
prominent because of a scandal. That ambiguity is real and is why the sign
of any effect matters as much as its size.

Article lookup is batched (the MediaWiki API takes up to 50 titles per
query) and matches on "Firstname Lastname" reconstructed from DGEQ's
"Lastname Firstname" column order.
"""

from __future__ import annotations

import time
import unicodedata
from datetime import date, timedelta

import httpx
import pandas as pd

USER_AGENT = "polls-research-bot/0.1 (contact: yysrk9lh@duck.com; research project on Quebec poll aggregation)"
API = "https://fr.wikipedia.org/w/api.php"
PAGEVIEWS = (
    "https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/"
    "fr.wikipedia/all-access/all-agents/{article}/daily/{start}/{end}"
)


def candidate_display_name(dgeq_name: str) -> str:
    """DGEQ writes "Lastname Firstname" (sometimes with particles); Wikipedia
    titles are "Firstname Lastname". Two-token names invert cleanly; longer
    ones are ambiguous, so the last token is treated as the given name and
    moved to the front, which is right for the common
    "Lastname Compound-Firstname" case."""
    parts = [p for p in dgeq_name.replace("(", " ").replace(")", " ").split() if p]
    if len(parts) < 2:
        return dgeq_name.strip()
    return f"{parts[-1]} {' '.join(parts[:-1])}"


def _strip_accents(text: str) -> str:
    return unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")


# A name match alone is not enough: "Serge Cloutier" resolves to a hockey
# player, "Martin Gagnon" to half a dozen unrelated people. Requiring the
# search snippet to read as a public-life biography discards those. It also
# discards the occasional genuine candidate whose article is about their
# non-political career, which biases the signal toward zero rather than
# inventing prominence that isn't there -- the safer direction for a
# predictor whose whole point is to be tested, not assumed.
RELEVANT = (
    "politi", "depute", "deputee", "ministre", "candidat", "elu", "elue",
    "parti quebecois", "coalition avenir", "quebec solidaire", "liberal",
    "conservateur", "journalist", "syndical", "maire", "mairesse", "conseiller municipal",
)


def find_articles(names: list[str], pause: float = 0.05) -> dict[str, str | None]:
    """{candidate name: article title or None}. Uses the search API rather
    than an exact-title lookup so that "Jean Boulet" matches
    "Jean Boulet (homme politique)". A hit is accepted only if the title
    carries both the given name and the surname AND the snippet reads as a
    public-life biography."""
    found: dict[str, str | None] = {}
    for name in names:
        try:
            resp = httpx.get(
                API,
                params={"action": "query", "list": "search", "srsearch": name, "format": "json", "srlimit": 3},
                headers={"User-Agent": USER_AGENT},
                timeout=20,
            )
            resp.raise_for_status()
            hits = resp.json().get("query", {}).get("search", [])
        except Exception:
            found[name] = None
            continue

        key = _strip_accents(name).lower()
        given, surname = key.split(" ", 1)[0], key.split(" ", 1)[-1]
        match = None
        for hit in hits:
            title = _strip_accents(hit["title"]).lower()
            if given not in title or surname not in title:
                continue
            snippet = _strip_accents(hit.get("snippet", "")).lower()
            if any(term in snippet or term in title for term in RELEVANT):
                match = hit["title"]
                break
        found[name] = match
        time.sleep(pause)
    return found


def fetch_pageviews(article: str, start: date, end: date) -> int:
    url = PAGEVIEWS.format(
        article=article.replace(" ", "_"), start=start.strftime("%Y%m%d"), end=end.strftime("%Y%m%d")
    )
    try:
        resp = httpx.get(url, headers={"User-Agent": USER_AGENT}, timeout=20)
        if resp.status_code != 200:
            return 0
        return sum(item["views"] for item in resp.json().get("items", []))
    except Exception:
        return 0


def build_candidate_signals(bv_results: pd.DataFrame, election_date: date, window_days: int = 60) -> pd.DataFrame:
    """One row per (riding, party): whether that candidate has a Wikipedia
    article and, if so, total pageviews in the `window_days` before the
    election."""
    totals = bv_results[bv_results["is_total_row"]][["riding_name", "party_code", "candidate_name"]].drop_duplicates()
    totals = totals[totals["party_code"].isin(["CAQ", "LIB", "QS", "PQ", "PCQ"])].copy()
    totals["display_name"] = totals["candidate_name"].map(candidate_display_name)

    unique_names = sorted(totals["display_name"].unique())
    articles = find_articles(unique_names)

    start, end = election_date - timedelta(days=window_days), election_date
    views_cache: dict[str, int] = {}
    for name, article in articles.items():
        if article:
            views_cache[name] = fetch_pageviews(article, start, end)

    totals["article"] = totals["display_name"].map(articles)
    totals["has_article"] = totals["article"].notna().astype(float)
    totals["pageviews"] = totals["display_name"].map(views_cache).fillna(0.0)
    return totals
