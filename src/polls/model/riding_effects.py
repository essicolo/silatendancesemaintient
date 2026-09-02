"""One regularized multivariate model for riding-level departure from the
provincial swing. No variable selection.

Everything available goes in -- demographics, economic sector shares, past
residual structure -- and ridge regularization handles the rest. A predictor
that carries no signal is shrunk toward zero by the penalty; it does not
need to be identified and removed. Explicit selection would only add
instability (which variables get picked flips with the sample) without
adding information the penalty isn't already extracting.

This replaces a long detour through per-coordinate R^2 screening, PCA
component-count tuning, and SHAP-ranked subsets, all of which were answering
a question that doesn't need answering here.

Geometry: response and residual predictors are ILR coordinates (full rank,
unlike CLR's sum-zero degeneracy). Regularization strength is chosen by
generalized cross-validation over a wide alpha grid, with a multivariate
loss -- the model is fit jointly across output coordinates, not one at a
time.
"""

from __future__ import annotations

from pathlib import Path

import duckdb
import nuee
import numpy as np
import pandas as pd
from sklearn.linear_model import RidgeCV
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

PARTIES = ["CAQ", "LIB", "QS", "PQ", "PCQ", "AUTRES"]
ALPHAS = np.logspace(-2, 4, 40)

DEMOGRAPHIC_COLS = [
    "median_age",
    "pct_french_home_lang",
    "median_household_income",
    "pct_university_degree",
    "pct_no_diploma",
    "pct_immigrant",
    "pct_visible_minority",
    "population_density",
    "pct_ind_agriculture",
    "pct_ind_manufacturing",
    "pct_ind_retail",
    "pct_ind_professional",
    "pct_ind_health_social",
]


def _ilr(shares: np.ndarray) -> np.ndarray:
    return nuee.ilr(nuee.closure(nuee.multiplicative_replacement(shares)))


def _riding_shares(
    con: duckdb.DuckDBPyConnection, election_date: str, boundary_year: str, party_codes: list[str] = PARTIES
) -> pd.DataFrame:
    df = con.execute(
        """
        SELECT riding_code, party_code, sum(votes) AS votes FROM election_results
        WHERE jurisdiction_code='qc-provincial' AND boundary_year=? AND election_date=?
          AND riding_code IS NOT NULL GROUP BY 1,2
        """,
        [boundary_year, election_date],
    ).df()
    df["party_code"] = df["party_code"].apply(lambda p: p if p in party_codes else "AUTRES")
    df = df.groupby(["riding_code", "party_code"])["votes"].sum().reset_index()
    wide = df.pivot_table(index="riding_code", columns="party_code", values="votes", fill_value=0.0)
    for p in party_codes:
        if p not in wide.columns:
            wide[p] = 0.0
    return wide[party_codes].div(wide[party_codes].sum(axis=1), axis=0)


def residual_ilr(
    con: duckdb.DuckDBPyConnection, date_a: str, boundary_a: str, date_b: str, boundary_b: str,
    party_codes: list[str] = PARTIES,
) -> pd.DataFrame:
    """Each riding's departure from the provincial swing, in ILR coordinates."""
    a = _riding_shares(con, date_a, boundary_a, party_codes)
    b = _riding_shares(con, date_b, boundary_b, party_codes)
    common = a.index.intersection(b.index)
    swing = _ilr(b.loc[common].to_numpy()) - _ilr(a.loc[common].to_numpy())
    return pd.DataFrame(swing - swing.mean(axis=0), index=common)


def _normalize(code) -> str:
    return str(int(float(code)))


def build_features(
    con: duckdb.DuckDBPyConnection, raw_dir: Path, party_codes: list[str] = PARTIES
) -> tuple[pd.DataFrame, np.ndarray, pd.Index]:
    """Predictors: riding demographics + the riding's own previous-cycle
    residual (ILR). Response: this cycle's residual (ILR)."""
    prev = residual_ilr(con, "2014-04-07", "2011", "2018-10-01", "2017", party_codes)
    curr = residual_ilr(con, "2018-10-01", "2017", "2022-10-03", "2017", party_codes)
    common = prev.index.intersection(curr.index)

    demo = con.execute(
        "SELECT riding_code, " + ", ".join(DEMOGRAPHIC_COLS)
        + " FROM riding_demographics WHERE jurisdiction_code='qc-provincial' AND boundary_year='2017'"
    ).df()
    demo["riding_code"] = demo["riding_code"].astype(str)

    # riding_demographics for the 2017 map is keyed by numeric Represent code
    # while these residuals are keyed by riding NAME, so bridge through the
    # boundary file rather than assuming the keys match.
    from polls.ingest.qc_ridings import download_riding_boundaries

    crosswalk = download_riding_boundaries(raw_dir).set_index("riding_name")["riding_code"].astype(str)
    demo = demo.set_index("riding_code")

    rows, keep = [], []
    for riding in common:
        code = crosswalk.get(riding)
        if code is None or code not in demo.index:
            continue
        rows.append(demo.loc[code, DEMOGRAPHIC_COLS].to_dict())
        keep.append(riding)

    X_demo = pd.DataFrame(rows, index=keep)
    X_prev = prev.loc[keep].add_prefix("prev_ilr_")
    X = pd.concat([X_demo, X_prev], axis=1).dropna()
    Y = curr.loc[X.index].to_numpy()
    return X, Y, X.index


def fit(X: pd.DataFrame, Y: np.ndarray):
    """Ridge with alpha chosen by GCV, fit jointly across all response
    coordinates. No feature dropped."""
    return make_pipeline(StandardScaler(), RidgeCV(alphas=ALPHAS)).fit(X, Y)


def multivariate_r2(model, X: pd.DataFrame, Y: np.ndarray, n_repeats: int = 40, seed: int = 0) -> float:
    """Out-of-sample R^2 under a multivariate loss (total squared error over
    all coordinates jointly), repeated 50% holdout."""
    rng = np.random.default_rng(seed)
    Xa = X.to_numpy() if hasattr(X, "to_numpy") else np.asarray(X)
    err_model, err_null = [], []
    for _ in range(n_repeats):
        idx = rng.permutation(len(Xa))
        half = len(Xa) // 2
        tr, te = idx[:half], idx[half:]
        m = make_pipeline(StandardScaler(), RidgeCV(alphas=ALPHAS)).fit(Xa[tr], Y[tr])
        err_model.append(((Y[te] - m.predict(Xa[te])) ** 2).sum())
        err_null.append(((Y[te] - Y[tr].mean(axis=0)) ** 2).sum())
    return float(1 - np.sum(err_model) / np.sum(err_null))


def predict_adjustment(
    model, riding_baseline: pd.DataFrame, features: pd.DataFrame, party_codes: list[str] = PARTIES,
    max_ilr_shift: float = 0.35,
) -> pd.DataFrame:
    """Apply the predicted ILR departure to each riding's baseline, staying
    on the simplex throughout (inverse-ILR cannot produce a negative share,
    so no clamping or redistribution is needed)."""
    base_ilr = nuee.ilr(nuee.closure(nuee.multiplicative_replacement(riding_baseline[party_codes].to_numpy())))
    base_df = pd.DataFrame(base_ilr, index=riding_baseline.index)

    common = base_df.index.intersection(features.index)
    if len(common) == 0:
        return riding_baseline.copy()

    shift = np.clip(model.predict(features.loc[common]), -max_ilr_shift, max_ilr_shift)
    base_df.loc[common] = base_df.loc[common].to_numpy() + shift
    shares = nuee.ilr_inv(base_df.to_numpy())
    return pd.DataFrame(shares, index=riding_baseline.index, columns=party_codes)


if __name__ == "__main__":
    import warnings

    warnings.filterwarnings("ignore")
    con = duckdb.connect("data/polls.duckdb")
    X, Y, idx = build_features(con, Path("data/raw"))
    print(f"n={len(X)} circonscriptions, {X.shape[1]} predicteurs (aucun retire), {Y.shape[1]} coordonnees ILR")
    model = fit(X, Y)
    ridge = model.named_steps["ridgecv"]
    print(f"alpha retenu par GCV : {ridge.alpha_:.3f}")
    print(f"R2 multivarie hors echantillon (50% hold-out x40) : {multivariate_r2(model, X, Y):+.4f}")
    con.close()
