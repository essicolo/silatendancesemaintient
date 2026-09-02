"""Head-to-head backtest of poll-aggregation methods, scored on the two
elections we can actually check against (QC 2018 and 2022).

The point is to answer "would a different probabilistic model do better?"
with evidence rather than preference. Candidates span the obvious families:
a naive baseline, a plain window average, the project's CLR weighted mean,
a random-walk state-space smoother (the classic poll-aggregation approach --
Jackman, Linzer), and the GP.

STRUCTURAL CAVEAT, stated up front because it limits everything below: there
are only two elections to score on, and both are from the same political
era. Two data points cannot reliably rank five models -- a difference of a
few tenths of a point in mean error here is noise, not evidence. This is
useful for catching a method that is clearly *broken*, and for confirming
the methods agree with each other; it cannot certify the winner. Treat rank
ordering as suggestive at best.
"""

from __future__ import annotations

from datetime import date, timedelta

import duckdb
import nuee
import numpy as np
import pandas as pd

from polls.model.backtest import actual_province_result
from polls.model.compositional import (
    aggregate_as_of,
    load_poll_composition,
    rating_weight,
    recency_weight,
    sample_size_weight,
    to_closed_composition,
)
from polls.model.gp_trend import fit_trend, predict_trend

PARTIES = ["CAQ", "LIB", "QS", "PQ", "PCQ", "AUTRES"]


def _window(wide: pd.DataFrame, as_of: date, days: int) -> pd.DataFrame:
    return wide[
        (wide["poll_date"] <= pd.Timestamp(as_of))
        & (wide["poll_date"] >= pd.Timestamp(as_of) - pd.Timedelta(days=days))
    ]


def last_poll(wide: pd.DataFrame, party_codes: list[str], as_of: date) -> dict:
    sub = wide[wide["poll_date"] <= pd.Timestamp(as_of)].sort_values("poll_date")
    row = sub.iloc[-1]
    return {p: row[p] for p in party_codes}


def simple_average(wide: pd.DataFrame, party_codes: list[str], as_of: date, days: int = 30) -> dict:
    sub = _window(wide, as_of, days)
    return {p: sub[p].mean() for p in party_codes}


def clr_weighted(wide: pd.DataFrame, party_codes: list[str], as_of: date, half_life: float = 10) -> dict:
    return aggregate_as_of(wide, party_codes, as_of, half_life_days=half_life, lookback_days=90)


def random_walk_smoother(
    wide: pd.DataFrame, party_codes: list[str], as_of: date, process_var: float = 0.01, lookback_days: int = 180
) -> dict:
    """Local-level state-space model in CLR space, run as a scalar Kalman
    filter per coordinate: latent opinion follows a random walk, each poll is
    a noisy observation whose variance comes from its own sample size and
    house rating. This is the standard poll-aggregation formulation, and
    unlike a fixed-decay weighted mean it lets the data decide how fast
    opinion is actually moving relative to sampling noise.
    """
    sub = _window(wide, as_of, lookback_days).sort_values("poll_date")
    if sub.empty:
        return None
    comp = to_closed_composition(sub, party_codes)
    clr_mat = nuee.clr(comp)

    w = sample_size_weight(sub["sample_size"]) * rating_weight(sub["firm_rating"])
    obs_var = 1.0 / np.clip(w / w.max(), 0.05, None)
    obs_var = obs_var / obs_var.min()

    days = (sub["poll_date"] - sub["poll_date"].min()).dt.days.to_numpy(dtype=float)

    state = clr_mat[0].copy()
    var = np.full(clr_mat.shape[1], 1.0)
    for i in range(1, len(sub)):
        dt = max(days[i] - days[i - 1], 0.0)
        var = var + process_var * dt  # predict
        k = var / (var + obs_var[i])  # Kalman gain
        state = state + k * (clr_mat[i] - state)  # update
        var = (1 - k) * var
    shares = nuee.clr_inv(state.reshape(1, -1))[0]
    return dict(zip(party_codes, shares))


def mean_abs_error(estimate: dict, actual: dict, party_codes: list[str]) -> float:
    return float(np.mean([abs(estimate.get(p, 0.0) - actual.get(p, 0.0)) for p in party_codes])) * 100


def run_comparison(con: duckdb.DuckDBPyConnection) -> pd.DataFrame:
    wide, _ = load_poll_composition(con, "qc-provincial", "National")
    elections = [date(2018, 10, 1), date(2022, 10, 3)]

    methods = {
        "last poll": lambda w, a: last_poll(w, PARTIES, a),
        "moyenne 30j": lambda w, a: simple_average(w, PARTIES, a, days=30),
        "CLR pondere (projet)": lambda w, a: clr_weighted(w, PARTIES, a),
        "marche aleatoire (Kalman)": lambda w, a: random_walk_smoother(w, PARTIES, a),
        # The GP is refit on only the polls available before `as_of`, so it
        # can't peek at post-election data the way a model fit on the full
        # series would.
        "GP": lambda w, a: {
            p: v["mean"]
            for p, v in predict_trend(
                fit_trend(w[w["poll_date"] <= pd.Timestamp(a)], PARTIES), a, seed=0
            ).items()
        },
    }

    rows = []
    for election in elections:
        actual = actual_province_result(con, election)
        actual = {p: actual.get(p, 0.0) for p in PARTIES}
        # cut off the day before the election so no post-election row leaks in
        as_of = election - timedelta(days=1)
        for name, fn in methods.items():
            est = fn(wide, as_of)
            if est is None:
                continue
            rows.append({"election": election.year, "method": name, "MAE_pp": mean_abs_error(est, actual, PARTIES)})
    return pd.DataFrame(rows)


if __name__ == "__main__":
    import warnings

    warnings.filterwarnings("ignore")
    con = duckdb.connect("data/polls.duckdb")
    df = run_comparison(con)
    pivot = df.pivot(index="method", columns="election", values="MAE_pp")
    pivot["moyenne"] = pivot.mean(axis=1)
    print("Erreur absolue moyenne (points de pourcentage), par election:\n")
    print(pivot.sort_values("moyenne").round(2).to_string())
    print("\nRappel: 2 elections seulement -- ne peut pas departager de facon fiable.")
