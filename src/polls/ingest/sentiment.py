"""Attention/sentiment proxy signals, in the spirit of the "alternative data"
feeds used in quant finance (search-attention, media tone, social buzz) as
auxiliary predictors rather than a manually-judged reputation score.

Two sources are wired up and confirmed reachable from this environment:
  - Wikipedia pageviews (official Wikimedia REST API): an attention/momentum
    proxy, documented in the finance literature as predictive of volatility
    (Moat et al. 2013) -- the direct analogue of a "search volume" factor.
  - Google Trends (via the unofficial `pytrends` client): the classic
    "investor attention" proxy (Da, Engelberg & Gao 2011). Reachable here,
    but it is a reverse-engineered API with no SLA -- expect occasional
    breakage/rate-limiting, unlike the documented Wikimedia endpoint.

GDELT (news tone -- the closest analogue to a RavenPack/news-sentiment feed)
is NOT reachable from this sandboxed environment: `api.gdeltproject.org`
resets the TCP connection outright, while the raw bulk-file mirror
`data.gdeltproject.org` does respond. Wiring up GDELT for real use means
either running this ingestion from a network that isn't blocked, or building
a heavier pipeline against the raw 15-minute GKG zip dumps instead of the
lightweight DOC 2.0 API. Left unimplemented for now.

Entity name lists (which Wikipedia article / search term maps to which
party or candidate) are intentionally passed in by the caller rather than
hardcoded here: leadership changes over time and the author's knowledge of
current leaders may be stale, so this is a config concern, not a scraping
concern.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

import duckdb
import httpx
import polars as pl

USER_AGENT = "polls-research-bot/0.1 (contact: yysrk9lh@duck.com)"

WIKIMEDIA_PAGEVIEWS_URL = (
    "https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/"
    "{project}/all-access/all-agents/{article}/daily/{start}/{end}"
)


@dataclass(frozen=True)
class Entity:
    jurisdiction_code: str
    entity_type: str  # 'party' | 'candidate'
    entity_code: str  # party_code, or a riding/candidate identifier
    wikipedia_article: str  # exact article title, e.g. "François_Legault"
    wikipedia_project: str = "fr.wikipedia"
    trends_keyword: str | None = None  # defaults to wikipedia_article.replace('_', ' ')


def fetch_wikipedia_pageviews(article: str, start: date, end: date, project: str = "fr.wikipedia") -> pl.DataFrame:
    url = WIKIMEDIA_PAGEVIEWS_URL.format(
        project=project,
        article=article.replace(" ", "_"),
        start=start.strftime("%Y%m%d"),
        end=end.strftime("%Y%m%d"),
    )
    resp = httpx.get(url, headers={"User-Agent": USER_AGENT}, timeout=30)
    resp.raise_for_status()
    items = resp.json().get("items", [])
    if not items:
        return pl.DataFrame()
    return pl.DataFrame(
        [
            {
                "signal_date": date(int(it["timestamp"][0:4]), int(it["timestamp"][4:6]), int(it["timestamp"][6:8])),
                "value": float(it["views"]),
            }
            for it in items
        ]
    )


def fetch_google_trends(keyword: str, geo: str, timeframe: str = "today 3-m") -> pl.DataFrame:
    from pytrends.request import TrendReq

    pt = TrendReq(hl="fr-CA", tz=300)
    pt.build_payload([keyword], timeframe=timeframe, geo=geo)
    df = pt.interest_over_time()
    if df.empty:
        return pl.DataFrame()
    df = df.reset_index()[["date", keyword]].rename(columns={keyword: "value"})
    df["signal_date"] = df["date"].dt.date
    return pl.from_pandas(df[["signal_date", "value"]])


def load_entity_signals(con: duckdb.DuckDBPyConnection, entity: Entity, start: date, end: date, geo: str = "CA-QC") -> int:
    total = 0

    pageviews = fetch_wikipedia_pageviews(entity.wikipedia_article, start, end, entity.wikipedia_project)
    if not pageviews.is_empty():
        rows = pageviews.with_columns(
            pl.lit(entity.jurisdiction_code).alias("jurisdiction_code"),
            pl.lit(entity.entity_type).alias("entity_type"),
            pl.lit(entity.entity_code).alias("entity_code"),
            pl.lit("wikipedia_pageviews").alias("source"),
            pl.lit("pageviews").alias("metric"),
        ).select(
            "jurisdiction_code", "entity_type", "entity_code", "signal_date", "source", "metric", "value"
        )
        con.register("_signals_incoming", rows)
        con.execute(
            """
            INSERT INTO sentiment_signals
            SELECT * FROM _signals_incoming
            ON CONFLICT (jurisdiction_code, entity_type, entity_code, signal_date, source, metric)
            DO UPDATE SET value = excluded.value
            """
        )
        con.unregister("_signals_incoming")
        total += len(rows)

    keyword = entity.trends_keyword or entity.wikipedia_article.replace("_", " ")
    try:
        trends = fetch_google_trends(keyword, geo=geo)
    except Exception:
        trends = pl.DataFrame()
    if not trends.is_empty():
        rows = trends.with_columns(
            pl.lit(entity.jurisdiction_code).alias("jurisdiction_code"),
            pl.lit(entity.entity_type).alias("entity_type"),
            pl.lit(entity.entity_code).alias("entity_code"),
            pl.lit("google_trends").alias("source"),
            pl.lit("search_interest").alias("metric"),
        ).select(
            "jurisdiction_code", "entity_type", "entity_code", "signal_date", "source", "metric", "value"
        )
        con.register("_signals_incoming", rows)
        con.execute(
            """
            INSERT INTO sentiment_signals
            SELECT * FROM _signals_incoming
            ON CONFLICT (jurisdiction_code, entity_type, entity_code, signal_date, source, metric)
            DO UPDATE SET value = excluded.value
            """
        )
        con.unregister("_signals_incoming")
        total += len(rows)

    return total
