"""Riding-level seat projection: apply the province-wide poll movement as a
uniform swing to each riding's most recent baseline result, entirely in CLR
space so the result is guaranteed to stay a valid composition (shares
non-negative, summing to 1) -- unlike naive additive swing ("+3pp to every
CAQ number"), which can push a party negative in a riding where it started
near zero and never renormalizes the rest.

    riding_forecast_clr = riding_baseline_clr + (province_forecast_clr - province_baseline_clr)

This is *uniform* swing: every riding moves by the same CLR delta,
regardless of its local demographics. qc125's own methodology explicitly
adjusts this by region/demographics instead ("variation proportionnelle
ajustée par région... tendances historiques et dynamiques régionales") --
riding_demographics is already built for that refinement (regress the
riding-level swing residuals on language/age/income/etc. and let the
projection vary by riding rather than apply one national number
everywhere), but isn't wired up yet. Treat this module as the baseline to
improve on, not the final model.
"""

from __future__ import annotations

import nuee
import numpy as np
import pandas as pd
import duckdb


def get_riding_baseline(
    con: duckdb.DuckDBPyConnection, jurisdiction_code: str, election_date: str, boundary_year: str, party_codes: list[str]
) -> pd.DataFrame:
    """Wide matrix: one row per riding, one column per party (share of vote),
    for a past election already expressed on the target boundary_year map."""
    df = con.execute(
        """
        SELECT riding_code, party_code, votes
        FROM election_results
        WHERE jurisdiction_code = ? AND election_date = ? AND boundary_year = ? AND riding_code IS NOT NULL
        """,
        [jurisdiction_code, election_date, boundary_year],
    ).df()
    df["party_code"] = df["party_code"].apply(lambda p: p if p in party_codes else "AUTRES")
    df = df.groupby(["riding_code", "party_code"])["votes"].sum().reset_index()
    wide = df.pivot_table(index="riding_code", columns="party_code", values="votes", fill_value=0.0)
    for p in party_codes:
        if p not in wide.columns:
            wide[p] = 0.0
    wide = wide[party_codes]
    return wide.div(wide.sum(axis=1), axis=0)


def uniform_clr_swing(
    riding_baseline: pd.DataFrame,
    province_baseline: dict[str, float],
    province_forecast: dict[str, float],
    party_codes: list[str],
) -> pd.DataFrame:
    baseline_mat = nuee.closure(nuee.multiplicative_replacement(riding_baseline[party_codes].to_numpy()))
    riding_clr = nuee.clr(baseline_mat)

    prov_base_clr = nuee.clr(nuee.closure(np.array([[province_baseline[p] for p in party_codes]])))[0]
    prov_fcst_clr = nuee.clr(nuee.closure(np.array([[province_forecast[p] for p in party_codes]])))[0]
    delta = prov_fcst_clr - prov_base_clr

    forecast_clr = riding_clr + delta
    forecast_shares = nuee.clr_inv(forecast_clr)

    out = pd.DataFrame(forecast_shares, index=riding_baseline.index, columns=party_codes)
    out["projected_winner"] = out[party_codes].idxmax(axis=1)
    return out


def seat_projection_summary(riding_forecast: pd.DataFrame, party_codes: list[str]) -> pd.Series:
    return riding_forecast["projected_winner"].value_counts().reindex(party_codes, fill_value=0)


# Estimated from the 2018 -> 2022 transition: see model/incumbency.py.
# Ridings where the incumbent ran again saw +0.3pp of excess swing (roughly
# the national average -- most ridings are this case, so it's already
# baked into what "uniform swing" implicitly assumes); open seats saw
# -4.0pp. The gap between the two, ~4.3pp, is what an open seat costs the
# outgoing party's *local* result beyond the province-wide trend. Based on
# one election transition (n=83 defended / n=37 open) -- a real effect at a
# plausible magnitude for incumbency advantage, not a precisely-pinned
# constant; re-run incumbency.py as more elections accumulate.
DEFAULT_INCUMBENCY_EFFECT_PP = 4.26

# Ridings where the 2022 incumbent is known NOT to be running again in 2026:
# {riding_code: party_that_loses_the_incumbency_premium}. User-provided,
# not independently verified against a candidate-nomination source (none
# exists yet this far ahead of the election) -- add/remove entries as
# retirements are confirmed.
KNOWN_OPEN_SEATS_2026 = {
    "121": "QS",  # Sherbrooke -- outgoing QS incumbent not running again (per user, 2026-08)
}


def recent_excess_swing_on_2026_map(
    con: duckdb.DuckDBPyConnection, party_codes: list[str], date_a: str = "2018-10-01", date_b: str = "2022-10-03"
) -> pd.DataFrame:
    """Each riding's 2018 -> 2022 excess swing (local swing minus the
    province-wide swing for that party), computed directly on the 2026 map
    via the DGEQ polling-division reprojection (both elections already
    exist at boundary_year='2026' -- see ingest/dgeq_bureau_vote.py). This
    sidesteps the riding-*name* matching that model/momentum.py needs when
    comparing across a redistricting: both dates here already share the
    same riding_code space, so no name join or partial-coverage loss.
    """
    df = con.execute(
        """
        SELECT riding_code, election_date, party_code, sum(votes) AS votes
        FROM election_results
        WHERE jurisdiction_code = 'qc-provincial' AND boundary_year = '2026'
          AND election_date IN (?, ?) AND riding_code IS NOT NULL
        GROUP BY 1, 2, 3
        """,
        [date_a, date_b],
    ).df()
    df["party_code"] = df["party_code"].apply(lambda p: p if p in party_codes else "AUTRES")
    df = df.groupby(["riding_code", "election_date", "party_code"])["votes"].sum().reset_index()

    shares = {}
    for date in (date_a, date_b):
        wide = df[df["election_date"] == date].pivot_table(
            index="riding_code", columns="party_code", values="votes", fill_value=0.0
        )
        for p in party_codes:
            if p not in wide.columns:
                wide[p] = 0.0
        shares[date] = wide[party_codes].div(wide[party_codes].sum(axis=1), axis=0)

    shares_a, shares_b = shares[date_a], shares[date_b]
    common = shares_a.index.intersection(shares_b.index)

    # CLR, not raw share differences: apply_momentum_adjustment and the slope
    # estimation in model/momentum.py both work in log-ratio space, and
    # mixing units here would silently rescale the effect.
    def to_clr(df: pd.DataFrame) -> pd.DataFrame:
        mat = nuee.clr(nuee.closure(nuee.multiplicative_replacement(df.loc[common, party_codes].to_numpy())))
        return pd.DataFrame(mat, index=common, columns=party_codes)

    swing = to_clr(shares_b) - to_clr(shares_a)
    # a riding missing from either date (the 2018 reprojection covers
    # 123/127 -- see dgeq_bureau_vote.py) drops out of `common` above rather
    # than propagating NaN into every downstream computation.
    return (swing - swing.mean()).dropna()


# Persistent riding-level SLOPE effects: does a riding that departed from
# the provincial swing in one cycle depart the same way in the next?
# Estimated in model/momentum.py across 2014->2018 and 2018->2022 (n=118
# name-matched ridings), now in CLR space.
#
# Not to be confused with a riding being "typically left/right" -- that is a
# persistent LEVEL effect, it is enormous (riding-level autocorrelation 0.71
# to 0.95 across elections), and it is already captured exactly, as a fixed
# effect, by starting each projection from that riding's own last result.
# A level trait cancels out under differencing, so it neither needs nor
# would benefit from a random effect here.
#
# What remains after that is slope persistence, and it is much thinner:
#   LIB  r=+0.29, slope 0.671, R^2=0.082   (ridings where it collapsed keep collapsing)
#   PCQ  r=+0.31, slope 0.904, R^2=0.096   (ridings where it grew keep growing)
#   CAQ/QS/PQ/AUTRES: at or below the null, nothing to act on.
#
# These slopes are ~2.7x SMALLER than the value previously shipped here
# (PCQ 2.485), which was estimated on raw share differences -- the same
# wrong-geometry error that inflated the demographic regression. A party
# rising off a near-zero base produces huge apparent share-space
# correlation that mostly vanishes in log-ratios.
#
# Both effects explain under 10% of variance. They are real and directionally
# sensible, not strong; treat them as a mild tilt, not a prediction.
# DISABLED -- the effect does not survive a correct compositional formulation.
# See model/momentum_ilr.py. Three successive corrections shrank it to nothing:
#   1. estimated on raw share differences   -> PCQ slope 2.485 ("11 -> 20 seats")
#   2. re-estimated in CLR                  -> PCQ 0.904, LIB 0.671 (0 seats moved)
#   3. formulated as a real compositional operation, in ILR:
#        single powering coefficient alpha = +0.039, R^2 = +0.001
#        per-ILR-coordinate: cross-validated R^2 NEGATIVE on 3 of 5 coordinates
#
# Step 3 is what killed it. Attaching a coefficient to a PARTY and adding it
# to that party's CLR coordinate treats CLR coordinates as independent when
# they sum to zero by construction: a targeted +0.50 on one party actually
# lands as +0.4167 on it (= (k-1)/k of the intent) and leaks -0.0833 onto
# every other party uniformly, a split nothing justifies. The apparent
# per-party momentum was that structure, not a real riding tendency.
#
# Kept as an empty dict rather than deleted so the wiring stays in place and
# the finding stays visible; re-enable only if a later election gives the
# ILR formulation a cross-validated R^2 worth having.
MOMENTUM_SLOPES: dict[str, float] = {}


def apply_momentum_adjustment(
    riding_baseline: pd.DataFrame,
    recent_excess_swing: pd.DataFrame,
    party_codes: list[str],
    slopes: dict[str, float] = MOMENTUM_SLOPES,
) -> pd.DataFrame:
    """Nudge each riding's baseline for `slopes`-covered parties by
    `slope * that riding's own recent excess swing`, before the national
    swing is applied.

    Both the estimation (model/momentum.py) and this application are in CLR
    space. They used to disagree -- estimated on raw share deltas, applied
    as a share-space shift with manual renormalization -- which is the same
    geometry error that inflated the demographic regression. Working in CLR
    also removes the need for the hand-rolled "don't go below zero, then
    redistribute to the others" bookkeeping: the inverse transform can't
    produce a negative share, so it's structurally impossible.

    `recent_excess_swing` must therefore be in CLR units too (see
    swing.recent_excess_swing_on_2026_map, which returns share-space values,
    or model/swing_residuals.measure_residuals which returns CLR).
    """
    # Cap the extrapolated shift: the slope was fit on ridings whose typical
    # excess swing was modest, not on the tail. Uncapped, a riding with an
    # unusually large past excess extrapolates to a shift the data can't
    # support. 0.35 in CLR is roughly a 1.4x relative change in a party's
    # share -- generous, but bounded.
    MAX_CLR_SHIFT = 0.35

    # Short-circuit when nothing applies. Without this the CLR round-trip
    # still perturbs the data via multiplicative zero-replacement, so a
    # "no adjustment" call silently returned slightly different shares than
    # it was given -- a no-op has to actually be a no-op.
    applicable = {p: s for p, s in slopes.items() if p in party_codes}
    if not applicable:
        return riding_baseline.copy()

    baseline_mat = nuee.closure(nuee.multiplicative_replacement(riding_baseline[party_codes].to_numpy()))
    clr_mat = nuee.clr(baseline_mat)
    clr_df = pd.DataFrame(clr_mat, index=riding_baseline.index, columns=party_codes)

    common = clr_df.index.intersection(recent_excess_swing.index)
    for party, slope in applicable.items():
        shift = (slope * recent_excess_swing.loc[common, party]).clip(-MAX_CLR_SHIFT, MAX_CLR_SHIFT)
        clr_df.loc[common, party] = clr_df.loc[common, party] + shift

    adjusted_shares = nuee.clr_inv(clr_df.to_numpy())
    return pd.DataFrame(adjusted_shares, index=riding_baseline.index, columns=party_codes)


def apply_open_seat_adjustment(
    riding_baseline: pd.DataFrame,
    open_seats: dict[str, str],
    party_codes: list[str],
    effect_pp: float = DEFAULT_INCUMBENCY_EFFECT_PP,
) -> pd.DataFrame:
    """Shave `effect_pp` off the outgoing incumbent's party share in each
    open-seat riding and redistribute it proportionally to the other
    parties in that riding, before any national swing is applied. Linear
    adjustment in share space (not CLR): the effect was estimated as a
    plain percentage-point difference, so applying it as one is more
    faithful to the estimate than converting it into a CLR shift whose
    magnitude would depend on the baseline share it's applied to.
    """
    # riding_code round-trips through pandas/DuckDB as e.g. "121.0" (see
    # swing.js's normalizeRidingCode for the same issue on the JS side);
    # match on the normalized form rather than assuming exact string equality.
    normalize = lambda c: str(int(float(c)))
    index_by_normalized = {normalize(c): c for c in riding_baseline.index}

    adjusted = riding_baseline.copy()
    for riding_code, party in open_seats.items():
        actual_index = index_by_normalized.get(normalize(riding_code))
        if actual_index is None or party not in party_codes:
            continue
        riding_code = actual_index
        row = adjusted.loc[riding_code, party_codes]
        shift = min(effect_pp / 100, row[party])  # never push the party's share below zero
        row[party] -= shift
        others = [p for p in party_codes if p != party]
        others_total = row[others].sum()
        if others_total > 0:
            row[others] += shift * (row[others] / others_total)
        adjusted.loc[riding_code, party_codes] = row
    return adjusted


def regional_clr_swing(
    riding_baseline: pd.DataFrame,
    riding_region: pd.Series,  # riding_code -> "MTL"/"QC"/"REG"
    region_baseline: dict[str, dict[str, float]],  # region_code -> {party: share}, 2022
    region_forecast: dict[str, dict[str, float]],  # region_code -> {party: share}, now
    party_codes: list[str],
) -> pd.DataFrame:
    """Same CLR-swing idea as uniform_clr_swing, but each riding swings by
    ITS OWN region's movement (qc125 publishes Montréal RMR / Québec RMR /
    Ailleurs au Québec poll splits -- see ingest/riding_regions.py) rather
    than one national number for every riding. Directly targets the pattern
    a uniform swing can't see: Montréal running more PLQ/QS than the
    province, Québec CMA (which includes the south shore, e.g. Lévis)
    running more PCQ.
    """
    baseline_mat = nuee.closure(nuee.multiplicative_replacement(riding_baseline[party_codes].to_numpy()))
    riding_clr = nuee.clr(baseline_mat)

    deltas_by_region = {}
    for region in region_baseline:
        base_clr = nuee.clr(nuee.closure(np.array([[region_baseline[region][p] for p in party_codes]])))[0]
        fcst_clr = nuee.clr(nuee.closure(np.array([[region_forecast[region][p] for p in party_codes]])))[0]
        deltas_by_region[region] = fcst_clr - base_clr

    forecast_clr = np.empty_like(riding_clr)
    for i, riding_code in enumerate(riding_baseline.index):
        region = riding_region.get(riding_code, "REG")
        forecast_clr[i] = riding_clr[i] + deltas_by_region[region]

    forecast_shares = nuee.clr_inv(forecast_clr)
    out = pd.DataFrame(forecast_shares, index=riding_baseline.index, columns=party_codes)
    out["projected_winner"] = out[party_codes].idxmax(axis=1)
    out["region"] = riding_baseline.index.map(lambda c: riding_region.get(c, "REG"))
    return out


def get_riding_baseline_with_byelections(
    con: duckdb.DuckDBPyConnection, party_codes: list[str], general_election_date: str = "2022-10-03"
) -> tuple[pd.DataFrame, pd.Series]:
    """Riding baseline (2017-map, riding NAME-indexed, matching how
    by-elections are stored) with any riding that's had a by-election since
    `general_election_date` overridden to that by-election's own result --
    a real, recent vote beats a 3+-year-old general-election result for
    that specific riding. Returns (baseline, baseline_date): baseline_date
    is per-riding, since it's no longer a single shared date once some
    ridings are on their by-election date and others are still on the
    general election's.
    """
    baseline = get_riding_baseline(con, "qc-provincial", general_election_date, "2017", party_codes)
    baseline_date = pd.Series(general_election_date, index=baseline.index)

    byelections = con.execute(
        """
        SELECT riding_code, election_date, party_code, votes
        FROM election_results
        WHERE jurisdiction_code = 'qc-provincial' AND boundary_year = '2017'
          AND election_date > ? AND riding_code IS NOT NULL
        ORDER BY election_date
        """,
        [general_election_date],
    ).df()
    if byelections.empty:
        return baseline, baseline_date

    for (riding, election_date), group in byelections.groupby(["riding_code", "election_date"]):
        election_date_str = pd.Timestamp(election_date).strftime("%Y-%m-%d")
        group = group.copy()
        group["party_code"] = group["party_code"].apply(lambda p: p if p in party_codes else "AUTRES")
        shares = group.groupby("party_code")["votes"].sum()
        shares = (shares / shares.sum()).reindex(party_codes, fill_value=0.0)
        if riding not in baseline.index:
            baseline.loc[riding] = 0.0  # a by-election riding not in the general-election join key (shouldn't happen for 2017-map names, but don't drop data if it does)
        baseline.loc[riding, party_codes] = shares.to_numpy()
        baseline_date.loc[riding] = election_date_str  # last (most recent) by-election wins, since rows are date-ordered

    return baseline, baseline_date


def mixed_baseline_clr_swing(
    riding_baseline: pd.DataFrame,
    baseline_date: pd.Series,
    province_estimate_at,  # Callable[[str], dict[str, float]]
    province_forecast: dict[str, float],
    party_codes: list[str],
) -> pd.DataFrame:
    """Same CLR-swing idea as uniform_clr_swing, but each riding swings
    forward from ITS OWN baseline date (2022 general, or a more recent
    by-election) rather than one shared date -- otherwise a riding updated
    to a 2025 by-election would get the national swing for 2022-to-now
    applied on top, double-counting whatever already happened by 2025.
    `province_estimate_at` is expected to be something like
    `functools.partial(compositional.aggregate_as_of, wide, party_codes)` or
    an equivalent GP-based estimator, called once per distinct baseline
    date present."""
    baseline_mat = nuee.closure(nuee.multiplicative_replacement(riding_baseline[party_codes].to_numpy()))
    riding_clr = nuee.clr(baseline_mat)

    prov_fcst_clr = nuee.clr(nuee.closure(np.array([[province_forecast[p] for p in party_codes]])))[0]

    forecast_clr = np.empty_like(riding_clr)
    for date in baseline_date.unique():
        prov_base = province_estimate_at(date)
        prov_base_clr = nuee.clr(nuee.closure(np.array([[prov_base[p] for p in party_codes]])))[0]
        delta = prov_fcst_clr - prov_base_clr
        mask = (baseline_date == date).to_numpy()
        forecast_clr[mask] = riding_clr[mask] + delta

    forecast_shares = nuee.clr_inv(forecast_clr)
    out = pd.DataFrame(forecast_shares, index=riding_baseline.index, columns=party_codes)
    out["projected_winner"] = out[party_codes].idxmax(axis=1)
    out["baseline_date"] = baseline_date
    return out
