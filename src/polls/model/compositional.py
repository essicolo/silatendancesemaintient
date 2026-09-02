"""Compositional-data helpers for aggregating polls: each poll is a point on
the simplex (party shares summing to 1), so a straight arithmetic mean
across polls is the wrong geometry -- it doesn't respect the multiplicative,
non-negative structure of shares (e.g. it can understate a party's real
relative movement when other parties are near zero). CLR (centered
log-ratio, via `nuee`) maps the simplex to unconstrained real space where
ordinary weighted averaging, regression, and Gaussian processes are valid,
then the result is mapped back with the inverse transform.
"""

from __future__ import annotations

from datetime import date, datetime

import duckdb
import nuee
import numpy as np
import pandas as pd

# Editorial house-quality rating (qc125's "cote du sondeur") -> multiplicative
# weight. Firms with no track record yet ('NC' = non coté) get a modest
# default rather than zero, so a single new pollster isn't invisible.
RATING_WEIGHTS = {
    "A+": 1.0,
    "A": 0.85,
    "B+": 0.7,
    "B": 0.55,
    "C+": 0.4,
    "C": 0.3,
    "NC": 0.5,
}


def load_poll_composition(
    con: duckdb.DuckDBPyConnection, jurisdiction_code: str, region_code: str = "National"
) -> tuple[pd.DataFrame, list[str]]:
    """Wide matrix: one row per poll (with firm/date/sample/rating metadata),
    one column per party_code, values = share in [0, 1]. Missing party
    columns for a given poll (no reported remainder) are filled with 0
    before closure."""
    long_df = con.execute(
        """
        SELECT p.poll_id, p.firm, p.poll_date, p.sample_size, p.firm_rating, s.party_code, s.pct_reported
        FROM polls p JOIN poll_shares s USING(poll_id)
        WHERE p.jurisdiction_code = ? AND p.region_code = ? AND p.general_election IS NULL
        ORDER BY p.poll_date
        """,
        [jurisdiction_code, region_code],
    ).df()

    party_codes = sorted(long_df["party_code"].unique())
    wide = long_df.pivot_table(
        index=["poll_id", "firm", "poll_date", "sample_size", "firm_rating"],
        columns="party_code",
        values="pct_reported",
        fill_value=0.0,
    ).reset_index()
    wide[party_codes] = wide[party_codes] / 100.0
    return wide, party_codes


def to_closed_composition(wide: pd.DataFrame, party_codes: list[str]) -> np.ndarray:
    """Simplex matrix, zero-replaced (CLR is undefined at exactly 0 -- a
    poll reporting 0% for a party is read as "below detection", not
    "impossible") and re-closed to sum to 1."""
    mat = wide[party_codes].to_numpy(dtype=float)
    # nuee's default delta is (1/k)^2 -- a poll with no reported "AUTRES"
    # residual almost certainly still had some non-zero minor-party/
    # undecided share, so this imputes something on the same order as what
    # other polls actually report for it, not an effectively-zero
    # placeholder. The JS port (compositional.js) matches this explicitly,
    # since @tangent.to/ds's own default is a much smaller fixed 1e-6.
    mat = nuee.multiplicative_replacement(mat)
    return nuee.closure(mat)


def campaign_half_life(as_of: date, election_date: date | None, base: float = 21.0, campaign: float = 4.0) -> float:
    """Recency half-life that tightens as an election approaches.

    Evidence (model/compare_aggregators.py + a half-life sweep on the 2018
    and 2022 backtests): error falls monotonically as the half-life shortens,
    2.42pp at 21 days down to 2.19pp at 3 days, and the naive "latest poll"
    baseline beats every smoother. Smoothers lag, and in the final days --
    when polls are dense and high-quality -- that lag is pure cost.

    But that evidence covers ONE moment only: the day before an election,
    the sole point where the true result is known. It says nothing about
    accuracy six weeks out, where polls are sparse and a 3-day half-life
    would effectively track a single poll's noise. So the short half-life is
    applied only inside the campaign window, reverting to the slower default
    outside it -- which is also qc125's stated behaviour ("le facteur de
    décroissance temporelle s'accentue en période de campagne électorale").
    The interpolation between the two is a smoothness choice, not a fitted
    result; there is no data to calibrate the middle of that ramp.
    """
    if election_date is None:
        return base
    days_out = (election_date - as_of).days
    if days_out <= 7:
        return campaign
    if days_out >= 35:
        return base
    # linear ramp between the campaign and default half-lives
    t = (days_out - 7) / (35 - 7)
    return campaign + t * (base - campaign)


def recency_weight(poll_dates: pd.Series, as_of: date, half_life_days: float = 21.0) -> np.ndarray:
    """Exponential decay; half_life_days shrinks during an active campaign
    in qc125's own methodology ("le facteur de décroissance temporelle
    s'accentue en période de campagne électorale") -- pass a shorter
    half_life explicitly when as_of falls within ~5 weeks of a known
    election date to reproduce that behaviour."""
    as_of_ts = pd.Timestamp(as_of)
    age_days = (as_of_ts - pd.to_datetime(poll_dates)).dt.days.to_numpy(dtype=float)
    age_days = np.clip(age_days, 0, None)  # ignore polls "in the future" relative to as_of
    return 0.5 ** (age_days / half_life_days)


def sample_size_weight(sample_sizes: pd.Series) -> np.ndarray:
    """sqrt(n): a common compromise for poll-weighting -- captures that a
    bigger sample is more informative without letting sample size alone
    dominate house-effect/recency weighting (variance scales with 1/n, so
    weighting by n itself would be "correct" for pure sampling error, but
    overstates precision once design effects/house effects are considered)."""
    n = sample_sizes.to_numpy(dtype=float)
    n = np.where(np.isnan(n) | (n <= 0), np.nanmedian(n), n)
    return np.sqrt(n)


def rating_weight(ratings: pd.Series) -> np.ndarray:
    return ratings.map(lambda r: RATING_WEIGHTS.get(r, RATING_WEIGHTS["NC"])).to_numpy(dtype=float)


def weighted_clr_mean(clr_mat: np.ndarray, weights: np.ndarray) -> np.ndarray:
    weights = weights / weights.sum()
    return np.average(clr_mat, axis=0, weights=weights)


def aggregate_as_of(
    wide: pd.DataFrame,
    party_codes: list[str],
    as_of: date,
    half_life_days: float = 21.0,
    lookback_days: int = 180,
) -> dict[str, float] | None:
    """Point-estimate aggregation: CLR-weighted mean of all polls in
    [as_of - lookback_days, as_of], inverse-transformed back to shares."""
    window = wide[
        (wide["poll_date"] <= pd.Timestamp(as_of)) & (wide["poll_date"] >= pd.Timestamp(as_of) - pd.Timedelta(days=lookback_days))
    ]
    if window.empty:
        return None

    comp = to_closed_composition(window, party_codes)
    clr_mat = nuee.clr(comp)

    w = recency_weight(window["poll_date"], as_of, half_life_days) * sample_size_weight(window["sample_size"]) * rating_weight(
        window["firm_rating"]
    )
    mean_clr = weighted_clr_mean(clr_mat, w)
    shares = nuee.clr_inv(mean_clr.reshape(1, -1))[0]
    return dict(zip(party_codes, shares))
