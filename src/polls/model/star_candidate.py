"""Does candidate prominence move a riding away from the provincial swing?

This was dismissed early in the project on the strength of a univariate
correlation between one leader's national pageviews and national vote share.
That test could not have answered the question: "star candidate" is a
riding-level, party-relative claim, and the national aggregate is exactly
where it would cancel out.

How prominence enters the model matters as much as whether it's included.
Candidate notability is not a per-party number to be attached to a party's
share. Within a riding, five candidates compete, and what could plausibly
move votes is the RELATIVE prominence among them -- a riding where the CAQ
runs a former minister against four unknowns is different from one where
every party runs a known name, even though the CAQ candidate is equally
notable in both. So the notability vector across parties is treated as a
composition and expressed in ILR, in the same party order and the same basis
as the response. Four predictor coordinates, four response coordinates, both
describing relative movement. Parameters land on log-ratios, which is the
only place they can mean anything here.

Two encodings are tested because they assume different things:
  - article/no-article, as counts 1 or 2 before closure: a threshold signal
  - pageviews + 1: continuous prominence, log-scaled by the ILR itself

Assessment uses the same multivariate criterion as the rest of the riding
model -- total-variance R^2 under repeated 50% holdout, with the penalty
chosen by cross-validation. No variable selection: if prominence carries no
signal, ridge shrinks it and the R^2 simply fails to improve.

RESULT (n=109, 2018->2022 departure, notability measured at 2022):

    demographics + previous residual        R2 = +0.3796   <- current model
      + article (ILR)                            +0.3655
      + pageviews (ILR)                          +0.3615
      + both                                     +0.3495
    notability alone (article)                   +0.0671
    notability alone (pageviews)                 +0.0182

Prominence does carry a little signal on its own, but adding it to the model
makes it worse. The reason is not the obvious one. It is NOT redundant with
the previous residual -- that predicts the notability coordinates at only
R^2 = 0.032, and the two blocks are close to additive (0.082 and 0.067
separately, 0.123 together). It is redundant with DEMOGRAPHICS, which
predict notability at R^2 = 0.240 and lose ground when it is added
(0.339 -> 0.313).

That is a substantive finding rather than a null one: where parties choose to
run a known name is itself largely a function of what kind of riding it is.
Montreal, media-adjacent and safe seats attract star candidates; the local
departure they appear to produce is mostly the riding's own character, which
the demographic block already measures more precisely. The pageviews version
is weaker still, consistent with prominence spiking for reasons unrelated to
the campaign.

Two further reasons not to include it, independent of the R^2:

  - Notability here is measured AT the election it is scoring, so even this
    number flatters it relative to a genuine forecast.
  - Prospectively it is unusable in the form tested: 2026 nominations are
    incomplete, so the candidate composition is unknown for most ridings.

Kept as a documented negative result rather than deleted, so the question
isn't reopened from scratch. The honest one-line summary: a star candidate
predicts what kind of riding they were recruited into better than they
predict how it votes.
"""

from __future__ import annotations

from datetime import date
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd

from polls.ingest.candidate_notability import build_candidate_signals
from polls.ingest.dgeq_bureau_vote import parse_bv_results
from polls.model.riding_effects import (
    DEMOGRAPHIC_COLS,
    PARTIES,
    _ilr,
    fit,
    multivariate_r2,
    residual_ilr,
)

TABLE = "candidate_notability"


def build_cache(con: duckdb.DuckDBPyConnection, raw_dir: Path) -> None:
    """Fetch and store the Wikipedia signals. Slow (one API call per unique
    candidate), so it is cached in the database rather than refetched."""
    con.execute(
        f"""CREATE TABLE IF NOT EXISTS {TABLE} (
            election_date DATE, riding_name VARCHAR, party_code VARCHAR,
            candidate_name VARCHAR, display_name VARCHAR, article VARCHAR,
            has_article DOUBLE, pageviews DOUBLE)"""
    )
    for election in (date(2018, 10, 1), date(2022, 10, 3)):
        existing = con.execute(f"SELECT count(*) FROM {TABLE} WHERE election_date=?", [election]).fetchone()[0]
        if existing:
            print(f"  {election}: {existing} lignes deja en cache")
            continue
        zip_path = raw_dir / f"dgeq_bv_gen_{election.isoformat()}.zip"
        print(f"  {election}: interrogation de Wikipedia...")
        signals = build_candidate_signals(parse_bv_results(zip_path), election)
        signals.insert(0, "election_date", election)
        con.execute(f"INSERT INTO {TABLE} SELECT * FROM signals")
        n_art = int(signals["has_article"].sum())
        print(f"  {election}: {len(signals)} candidats, {n_art} avec un article ({n_art/len(signals)*100:.0f}%)")


def notability_ilr(con: duckdb.DuckDBPyConnection, election: date, column: str) -> pd.DataFrame:
    """Riding -> ILR of the party-wise notability composition."""
    rows = con.execute(
        f"SELECT riding_name, party_code, {column} AS v FROM {TABLE} WHERE election_date=?", [election]
    ).df()
    wide = rows.pivot_table(index="riding_name", columns="party_code", values="v", aggfunc="max")
    # A party absent from a riding is not "zero prominence" on the same scale
    # as a present-but-unknown candidate; both get the floor, since neither
    # attracts a personal vote.
    wide = wide.reindex(columns=PARTIES).fillna(0.0)
    coords = _ilr(wide.to_numpy(dtype=float) + 1.0)
    return pd.DataFrame(coords, index=wide.index)


def run(con: duckdb.DuckDBPyConnection, raw_dir: Path) -> None:
    from polls.model.backtest_effects import _demographics

    build_cache(con, raw_dir)

    target = residual_ilr(con, "2018-10-01", "2017", "2022-10-03", "2017")
    prior = residual_ilr(con, "2014-04-07", "2011", "2018-10-01", "2017")
    by_code, crosswalk = _demographics(con, raw_dir, "2017")

    blocks = {
        "article": notability_ilr(con, date(2022, 10, 3), "has_article"),
        "pages": notability_ilr(con, date(2022, 10, 3), "pageviews"),
    }

    common = target.index.intersection(prior.index)
    for block in blocks.values():
        common = common.intersection(block.index)

    demo, prev, art, pages, Y = [], [], [], [], []
    for riding in common:
        code = crosswalk.get(riding)
        if code is None or code not in by_code.index:
            continue
        row = by_code.loc[code, DEMOGRAPHIC_COLS]
        if row.isna().any():
            continue
        demo.append(row.to_numpy(dtype=float))
        prev.append(prior.loc[riding].to_numpy())
        art.append(blocks["article"].loc[riding].to_numpy())
        pages.append(blocks["pages"].loc[riding].to_numpy())
        Y.append(target.loc[riding].to_numpy())

    demo, prev, art, pages, Y = map(np.asarray, (demo, prev, art, pages, Y))
    print(f"\nn = {len(Y)} circonscriptions\n")

    designs = {
        "demographie + residu precedent (modele actuel)": np.hstack([demo, prev]),
        "  + article Wikipedia (ILR)": np.hstack([demo, prev, art]),
        "  + pages vues (ILR)": np.hstack([demo, prev, pages]),
        "  + les deux": np.hstack([demo, prev, art, pages]),
        "notoriete seule (article)": art,
        "notoriete seule (pages vues)": pages,
    }

    for label, X in designs.items():
        model = fit(X, Y)
        r2 = multivariate_r2(model, X, Y)
        alpha = model[-1].alpha_
        print(f"{label:48s}  p={X.shape[1]:>2d}  alpha={alpha:>8.2f}  R2 = {r2:+.4f}")

    # Where does the standalone signal come from? If notability is mostly a
    # restatement of "this party holds the seat with a well-known member",
    # then it is already inside the previous-residual block, and adding it
    # only costs variance. Two checks: does it survive next to demographics
    # alone (no previous residual), and how much of it does the previous
    # residual explain on its own?
    print()
    for label, X in {
        "demographie seule": demo,
        "demographie + article": np.hstack([demo, art]),
        "residu precedent seul": prev,
        "residu precedent + article": np.hstack([prev, art]),
    }.items():
        model = fit(X, Y)
        print(f"{label:48s}  p={X.shape[1]:>2d}  R2 = {multivariate_r2(model, X, Y):+.4f}")

    # Direct redundancy measure: how well the previous residual predicts the
    # notability coordinates themselves.
    print()
    for label, Z in {"le residu precedent": prev, "la demographie": demo}.items():
        m = fit(Z, art)
        print(f"{'notoriete predite par ' + label:48s}       R2 = {multivariate_r2(m, Z, art):+.4f}")


if __name__ == "__main__":
    import warnings

    warnings.filterwarnings("ignore")
    con = duckdb.connect("data/polls.duckdb")
    run(con, Path("data/raw"))
    con.close()
