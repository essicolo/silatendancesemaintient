"""Estimated (not just editorially-rated) house effects: each pollster's
systematic CLR-space deviation from the underlying trend, net of sampling
noise.

Two-pass approach: fit the trend once without any house adjustment, take
each poll's residual (its CLR value minus the trend's CLR value on that
date), then average residuals per firm -- weighted by sample size, and
shrunk toward zero for firms with few polls (empirical-Bayes-style: a house
with 2 polls that happen to run high shouldn't be treated as confidently
biased as one with 50). Re-fitting the trend on de-biased data is then a
better estimate of the true underlying trend, since firm-specific stylistic
effects (question wording, panel composition, etc.) no longer masquerade as
real movement.

This is a plug-in refinement of gp_trend.fit_trend, not a replacement: call
estimate_house_effects() once, feed the result to fit_trend(..., house_effects=...).
"""

from __future__ import annotations

import nuee
import numpy as np
import pandas as pd

from polls.model.compositional import to_closed_composition
from polls.model.gp_trend import fit_trend, predict_trend


SHRINKAGE_K = 4.0  # pseudo-count: a firm needs ~this many polls before its
# estimated bias is trusted at close to full strength


def estimate_house_effects(wide: pd.DataFrame, party_codes: list[str]) -> pd.DataFrame:
    """Returns one row per firm: shrunk CLR-space bias vector (as separate
    columns clr_bias_0..clr_bias_{k-2}) plus n_polls and raw (unshrunk) bias
    for transparency."""
    baseline_model = fit_trend(wide, party_codes)

    comp = to_closed_composition(wide, party_codes)
    clr_mat = nuee.clr(comp)[:, :-1]

    residuals = np.zeros_like(clr_mat)
    for i, row in enumerate(wide.itertuples()):
        pred = predict_trend(baseline_model, row.poll_date.date(), n_samples=1)
        # predict_trend returns simplex-space stats; recompute the CLR mean
        # directly from the GP means instead of round-tripping through the
        # simplex, since that's what we need to compare against clr_mat.
        x = np.array([[(pd.Timestamp(row.poll_date) - baseline_model["t0"]).days]], dtype=float)
        trend_clr = np.array([gp.predict(x)[0] for gp in baseline_model["gps"]])
        residuals[i] = clr_mat[i] - trend_clr

    resid_df = pd.DataFrame(residuals, columns=[f"clr_bias_{i}" for i in range(residuals.shape[1])])
    resid_df["firm"] = wide["firm"].values
    resid_df["sample_size"] = wide["sample_size"].values

    def _weighted_mean(g: pd.DataFrame) -> pd.Series:
        w = g["sample_size"].fillna(g["sample_size"].median())
        bias_cols = [c for c in g.columns if c.startswith("clr_bias_")]
        raw = pd.Series({c: np.average(g[c], weights=w) for c in bias_cols})
        raw["n_polls"] = len(g)
        return raw

    per_firm = resid_df.groupby("firm").apply(_weighted_mean, include_groups=False)
    shrink = per_firm["n_polls"] / (per_firm["n_polls"] + SHRINKAGE_K)
    bias_cols = [c for c in per_firm.columns if c.startswith("clr_bias_")]
    for c in bias_cols:
        per_firm[c] = per_firm[c] * shrink

    return per_firm.reset_index()


def debias_wide(wide: pd.DataFrame, party_codes: list[str], house_effects: pd.DataFrame) -> pd.DataFrame:
    """Returns a copy of `wide` with each party share adjusted to remove its
    firm's estimated CLR-space bias before the trend/aggregation is fit."""
    comp = to_closed_composition(wide, party_codes)
    clr_mat = nuee.clr(comp)[:, :-1]

    bias_cols = [c for c in house_effects.columns if c.startswith("clr_bias_")]
    bias_by_firm = house_effects.set_index("firm")[bias_cols]

    debiased_clr = clr_mat.copy()
    for i, firm in enumerate(wide["firm"].values):
        if firm in bias_by_firm.index:
            debiased_clr[i] -= bias_by_firm.loc[firm].to_numpy()

    last_coord = -debiased_clr.sum(axis=1, keepdims=True)
    full_clr = np.concatenate([debiased_clr, last_coord], axis=1)
    debiased_shares = nuee.clr_inv(full_clr)

    out = wide.copy()
    out[party_codes] = debiased_shares
    return out
