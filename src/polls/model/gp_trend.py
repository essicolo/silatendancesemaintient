"""Smooth party-support trend + uncertainty over time via Gaussian process
regression in CLR space.

Each CLR coordinate (k-1 independent real-valued series for k parties, since
CLR coordinates sum to zero and the last is redundant -- dropped here and
reconstructed on the way back) gets its own GP over poll date, with
per-observation noise variance set from that poll's effective weight
(recency x sample size x house rating): a poll far in the past or from a
small/low-rated house is treated as a noisier observation, so the GP leans
on it less and its credible band widens between polls, rather than the
trend being forced through every point equally.

Fitting independent GPs per coordinate (rather than a single multi-output
GP with a shared/cross-coordinate kernel) is a simplification: it ignores
that CLR coordinates are correlated (a gain for one party is someone else's
loss). For the point estimate and marginal bands per party this is a fine
approximation; if a full compositional joint distribution is needed later
(e.g. "P(party A ahead of B)"), replace this with a multi-task GP or model
the (k-1)-dimensional CLR vector jointly.
"""

from __future__ import annotations

from datetime import date, timedelta

import nuee
import numpy as np
import pandas as pd
from sklearn.gaussian_process import GaussianProcessRegressor
from sklearn.gaussian_process.kernels import ConstantKernel, Matern, WhiteKernel

from polls.model.compositional import rating_weight, sample_size_weight, to_closed_composition


def _fit_gp(x: np.ndarray, y: np.ndarray, obs_noise: np.ndarray) -> GaussianProcessRegressor:
    kernel = ConstantKernel(1.0, (1e-2, 1e2)) * Matern(length_scale=30.0, length_scale_bounds=(5.0, 1500.0), nu=1.5)
    gp = GaussianProcessRegressor(kernel=kernel, alpha=obs_noise, normalize_y=True, n_restarts_optimizer=3)
    gp.fit(x.reshape(-1, 1), y)
    return gp


def fit_trend(wide: pd.DataFrame, party_codes: list[str]) -> dict:
    """Returns a fitted-model bundle: one GP per CLR coordinate (all but the
    last party, which is redundant), plus enough metadata to predict()."""
    comp = to_closed_composition(wide, party_codes)
    clr_mat = nuee.clr(comp)[:, :-1]  # drop redundant last coordinate

    t0 = wide["poll_date"].min()
    x = (wide["poll_date"] - t0).dt.days.to_numpy(dtype=float)

    weight = sample_size_weight(wide["sample_size"]) * rating_weight(wide["firm_rating"])
    weight = weight / weight.max()
    obs_noise = 1.0 / np.clip(weight, 0.05, None)  # inverse weight -> noise variance for GaussianProcessRegressor's alpha
    obs_noise = obs_noise / obs_noise.min()  # normalize so the best poll has ~unit noise

    gps = [_fit_gp(x, clr_mat[:, i], obs_noise) for i in range(clr_mat.shape[1])]
    return {"gps": gps, "t0": t0, "party_codes": party_codes}


def predict_trend(model: dict, as_of: date, n_samples: int = 2000, seed: int | None = None) -> dict:
    """Point estimate (mean) + a Monte Carlo credible interval per party,
    obtained by sampling the (independent) GP posteriors in CLR space and
    inverse-transforming each sample back to the simplex -- inverse-CLR is
    nonlinear, so simplex-space quantiles are computed from samples rather
    than analytically propagating the CLR-space Gaussian."""
    rng = np.random.default_rng(seed)
    x = np.array([[(pd.Timestamp(as_of) - model["t0"]).days]], dtype=float)

    means, stds = [], []
    for gp in model["gps"]:
        m, s = gp.predict(x, return_std=True)
        means.append(m[0])
        stds.append(s[0])
    means, stds = np.array(means), np.array(stds)

    samples_clr_partial = rng.normal(means, stds, size=(n_samples, len(means)))
    last_coord = -samples_clr_partial.sum(axis=1, keepdims=True)  # CLR coordinates sum to zero
    samples_clr = np.concatenate([samples_clr_partial, last_coord], axis=1)
    samples_simplex = nuee.clr_inv(samples_clr)

    party_codes = model["party_codes"]
    result = {}
    for i, party in enumerate(party_codes):
        col = samples_simplex[:, i]
        result[party] = {
            "mean": float(col.mean()),
            "p05": float(np.percentile(col, 5)),
            "p50": float(np.percentile(col, 50)),
            "p95": float(np.percentile(col, 95)),
        }
    return result


def predict_trend_series(model: dict, start: date, end: date, step_days: int = 7, **kwargs) -> pd.DataFrame:
    rows = []
    d = start
    while d <= end:
        est = predict_trend(model, d, **kwargs)
        for party, stats in est.items():
            rows.append({"date": d, "party_code": party, **stats})
        d += timedelta(days=step_days)
    return pd.DataFrame(rows)
