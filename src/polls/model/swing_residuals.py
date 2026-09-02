"""Riding-level swing heterogeneity, treated as an identifiable variance
rather than an unidentifiable mean.

The problem with uniform swing is not that it's a rough approximation --
it's that it asserts something measurably false. Ridings do not move
together: over 2018->2022 the standard deviation of a riding's departure
from the provincial swing was 0.498 in CLR units against a provincial swing
of 0.659, i.e. the "deviation" is ~0.8x the size of the movement it deviates
from. In percentage points, uniform swing missed each riding's CAQ result by
6.5 points on average and 13.2 points at the 90th percentile -- easily enough
to flip a seat.

The identifiability problem is real and does not go away: national polls
supply ~k free numbers per period, and there are 127 x k riding-level
quantities to pin down. Which specific riding will over- or under-perform is
not identifiable from national polls, and riding demographics failed to
predict it when tested properly (see model/riding_gp.py -- no out-of-sample
signal once region is accounted for).

What IS identifiable is the *distribution* of those departures, estimated
directly from past elections. So instead of pretending each riding's
deviation is zero (which is what a deterministic uniform swing does), the
seat simulation should draw a deviation for every riding from that measured
distribution. That converts a false point assertion into an honest
uncertainty statement: we don't know which ridings will break from the
national trend, but we know roughly how many will and by how much.

Implementation note: deviations are resampled from the observed historical
residuals (a bootstrap over ridings) rather than drawn from a fitted
Gaussian. The residuals across parties within one riding are strongly
dependent -- CLR coordinates sum to zero, and a riding where the CAQ
collapses is mechanically one where someone else surges -- so resampling
whole riding-vectors preserves that correlation structure for free, whereas
independent per-party Gaussians would destroy it and produce incoherent
compositions.
"""

from __future__ import annotations

import duckdb
import nuee
import numpy as np
import pandas as pd

PARTIES = ["CAQ", "LIB", "QS", "PQ", "PCQ", "AUTRES"]


def _clr_frame(shares: pd.DataFrame, party_codes: list[str]) -> pd.DataFrame:
    mat = nuee.clr(nuee.closure(nuee.multiplicative_replacement(shares[party_codes].to_numpy())))
    return pd.DataFrame(mat, index=shares.index, columns=party_codes)


def measure_residuals(
    con: duckdb.DuckDBPyConnection,
    date_a: str,
    date_b: str,
    party_codes: list[str] = PARTIES,
    boundary_year: str = "2026",
) -> pd.DataFrame:
    """Each riding's departure from the provincial swing, in CLR space, for
    one historical transition. One row per riding, one column per party."""
    from polls.model.backtest_seats import riding_shares

    shares_a = riding_shares(con, date_a, boundary_year)
    shares_b = riding_shares(con, date_b, boundary_year)
    common = shares_a.index.intersection(shares_b.index)
    swing = _clr_frame(shares_b.loc[common], party_codes) - _clr_frame(shares_a.loc[common], party_codes)
    return swing - swing.mean()


def measure_residuals_by_name(
    con: duckdb.DuckDBPyConnection, date_a: str, boundary_a: str, date_b: str, boundary_b: str,
    party_codes: list[str] = PARTIES,
) -> pd.DataFrame:
    """Same as measure_residuals but joining two elections held on different
    riding maps, by riding NAME. Only usable for estimating the residual
    *distribution* -- riding identity across a redistricting is approximate,
    but the spread of deviations doesn't depend on getting each riding's
    identity exactly right."""

    def shares(date_str: str, boundary: str) -> pd.DataFrame:
        df = con.execute(
            """
            SELECT riding_code, party_code, sum(votes) AS votes FROM election_results
            WHERE jurisdiction_code='qc-provincial' AND boundary_year=? AND election_date=?
              AND riding_code IS NOT NULL GROUP BY 1,2
            """,
            [boundary, date_str],
        ).df()
        df["party_code"] = df["party_code"].apply(lambda p: p if p in party_codes else "AUTRES")
        df = df.groupby(["riding_code", "party_code"])["votes"].sum().reset_index()
        wide = df.pivot_table(index="riding_code", columns="party_code", values="votes", fill_value=0.0)
        for p in party_codes:
            if p not in wide.columns:
                wide[p] = 0.0
        return wide[party_codes].div(wide[party_codes].sum(axis=1), axis=0)

    a, b = shares(date_a, boundary_a), shares(date_b, boundary_b)
    common = a.index.intersection(b.index)
    swing = _clr_frame(b.loc[common], party_codes) - _clr_frame(a.loc[common], party_codes)
    return swing - swing.mean()


def pooled_residuals(con: duckdb.DuckDBPyConnection, party_codes: list[str] = PARTIES) -> pd.DataFrame:
    """Residuals pooled across every transition available.

    Pooling matters because the magnitude is not stable: mean residual SD
    was 0.227 over 2014->2018 but 0.498 over 2018->2022. For the established
    parties it's consistent (CAQ 0.33/0.36, QS 0.24/0.30, PQ 0.27/0.32); the
    gap comes almost entirely from parties that were emerging or collapsing
    (PCQ 0.16 -> 0.68), where a small base makes the log-ratio swing wildly.
    Estimating from 2018->2022 alone would bake that one unusual election's
    turbulence in as if it were the norm; pooling gives a distribution that
    spans both a calm and a volatile cycle.
    """
    frames = [
        measure_residuals_by_name(con, "2014-04-07", "2011", "2018-10-01", "2017", party_codes),
        measure_residuals_by_name(con, "2018-10-01", "2026", "2022-10-03", "2026", party_codes),
    ]
    return pd.concat(frames, ignore_index=True)


def residual_summary(residuals: pd.DataFrame) -> pd.Series:
    return residuals.std()


def sample_residuals(residuals: pd.DataFrame, n_ridings: int, rng: np.random.Generator) -> np.ndarray:
    """Bootstrap n_ridings whole residual vectors (with replacement), keeping
    each riding's cross-party correlation intact."""
    idx = rng.integers(0, len(residuals), size=n_ridings)
    return residuals.to_numpy()[idx]


def simulate_seats_with_heterogeneity(
    riding_baseline: pd.DataFrame,
    province_baseline: dict[str, float],
    province_draws: list[dict[str, float]],
    residuals: pd.DataFrame,
    party_codes: list[str] = PARTIES,
    seed: int = 0,
) -> pd.DataFrame:
    """One row per simulation draw, one column per party = seats won.

    Each draw combines two independent sources of uncertainty that the
    previous simulation collapsed into one: the national vote share (from
    the poll model) AND each riding's own departure from that national
    movement (from history). Only propagating the first is what made the old
    seat intervals too narrow.
    """
    rng = np.random.default_rng(seed)
    baseline_clr = _clr_frame(riding_baseline, party_codes).to_numpy()
    prov_base_clr = nuee.clr(nuee.closure(np.array([[province_baseline[p] for p in party_codes]])))[0]

    rows = []
    for draw in province_draws:
        prov_draw_clr = nuee.clr(nuee.closure(np.array([[draw[p] for p in party_codes]])))[0]
        delta = prov_draw_clr - prov_base_clr
        noise = sample_residuals(residuals, len(riding_baseline), rng)
        forecast_clr = baseline_clr + delta + noise
        shares = nuee.clr_inv(forecast_clr)
        winners = np.array(party_codes)[shares.argmax(axis=1)]
        rows.append({p: int((winners == p).sum()) for p in party_codes})
    return pd.DataFrame(rows)
