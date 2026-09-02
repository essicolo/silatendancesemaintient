"""Seat backtest of the riding-effects model, without leakage.

The earlier backtest (model/backtest_seats.py) scored the core swing model
only. This one scores the model the dashboard actually runs: national swing
PLUS a riding-specific departure predicted from demographics and the
riding's own previous departure.

Avoiding circularity is the whole difficulty here. The effects model needs
two consecutive transitions to train (A->B predicting B->C), and there are
only three usable elections. Training on 2014->2018 -> 2018->2022 and then
scoring on 2022 would be scoring on data the model was fit to.

So the test is run the other way round: train on the FORWARD pair and score
the BACKWARD one. Concretely, fit "2018->2022 departures explained by
demographics + 2014->2018 departures", then invert the roles to predict
2014->2018 from demographics + 2018->2022 and score against the real 2018
result. The relationship being tested (do demographics explain local
departure?) is symmetric in time even though the causal story isn't, so
this measures whether the fitted relationship transfers to an election the
fit never saw.

That is a weaker guarantee than a genuine out-of-time test, and it is stated
rather than hidden: with three elections there is no way to do better. The
number below should be read as "does adding the effects model help or hurt",
not as a calibrated forecast accuracy.
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

from polls.model.riding_effects import (
    ALPHAS,
    DEMOGRAPHIC_COLS,
    PARTIES,
    _ilr,
    _riding_shares,
    residual_ilr,
)

_norm = lambda c: str(int(float(c))) if str(c).replace(".", "").isdigit() else str(c)


def _demographics(con: duckdb.DuckDBPyConnection, raw_dir: Path, boundary_year: str) -> pd.DataFrame:
    from polls.ingest.qc_ridings import download_riding_boundaries

    demo = con.execute(
        "SELECT riding_code, " + ", ".join(DEMOGRAPHIC_COLS)
        + " FROM riding_demographics WHERE jurisdiction_code='qc-provincial' AND boundary_year=?",
        [boundary_year],
    ).df()
    demo["riding_code"] = demo["riding_code"].astype(str).map(_norm)
    crosswalk = download_riding_boundaries(raw_dir).set_index("riding_name")["riding_code"].astype(str).map(_norm)
    by_code = demo.set_index("riding_code")
    return by_code, crosswalk


def _design(con, raw_dir, predictor_residual: pd.DataFrame, target_residual: pd.DataFrame):
    by_code, crosswalk = _demographics(con, raw_dir, "2017")
    common = predictor_residual.index.intersection(target_residual.index)

    X, Y, names = [], [], []
    for riding in common:
        code = crosswalk.get(riding)
        if code is None or code not in by_code.index:
            continue
        demo_row = by_code.loc[code, DEMOGRAPHIC_COLS]
        if demo_row.isna().any():
            continue
        X.append([*demo_row.to_numpy(dtype=float), *predictor_residual.loc[riding].to_numpy()])
        Y.append(target_residual.loc[riding].to_numpy())
        names.append(riding)
    return np.array(X), np.array(Y), names


def run(con: duckdb.DuckDBPyConnection, raw_dir: Path) -> dict:
    r_14_18 = residual_ilr(con, "2014-04-07", "2011", "2018-10-01", "2017")
    r_18_22 = residual_ilr(con, "2018-10-01", "2017", "2022-10-03", "2017")

    # Fit: demographics + 2014->2018 departure  ->  2018->2022 departure
    X_fit, Y_fit, _ = _design(con, raw_dir, r_14_18, r_18_22)
    model = make_pipeline(StandardScaler(), RidgeCV(alphas=ALPHAS)).fit(X_fit, Y_fit)

    # Score on 2018, an election the fit never saw: predict its departure
    # from demographics + the 2018->2022 departure, and rebuild 2018 from
    # the 2014 baseline plus provincial swing plus that prediction.
    X_score, Y_score, names = _design(con, raw_dir, r_18_22, r_14_18)
    # Same clamp as the production pipeline (applyEffectsToForecast /
    # simulate.js): the backtest must score the model as deployed, not an
    # unclamped variant of it.
    predicted = np.clip(model.predict(X_score), -0.35, 0.35)

    shares_2014 = _riding_shares(con, "2014-04-07", "2011").loc[names]
    shares_2018 = _riding_shares(con, "2018-10-01", "2017").loc[names]

    ilr_2014 = _ilr(shares_2014[PARTIES].to_numpy())
    ilr_2018 = _ilr(shares_2018[PARTIES].to_numpy())
    province_swing = (ilr_2018 - ilr_2014).mean(axis=0)

    actual_winner = shares_2018[PARTIES].idxmax(axis=1).to_numpy()

    def winners(ilr_pred: np.ndarray) -> np.ndarray:
        shares = nuee.ilr_inv(ilr_pred)
        return np.array(PARTIES)[shares.argmax(axis=1)]

    uniform = winners(ilr_2014 + province_swing)
    with_effects = winners(ilr_2014 + province_swing + predicted)
    no_change = shares_2014[PARTIES].idxmax(axis=1).to_numpy()

    def score(pred):
        correct = int((pred == actual_winner).sum())
        seat_err = int(sum(abs((pred == p).sum() - (actual_winner == p).sum()) for p in PARTIES))
        return {"correct": correct, "n": len(actual_winner), "accuracy": correct / len(actual_winner), "seat_error": seat_err}

    # Competitive = margin under 10 points at the starting election, where a
    # model can actually add value; the rest are near-automatic holds.
    sorted_shares = np.sort(shares_2014[PARTIES].to_numpy(), axis=1)
    margin = sorted_shares[:, -1] - sorted_shares[:, -2]
    close = margin < 0.10

    return {
        "aucun changement": score(no_change),
        "swing national seul": score(uniform),
        "swing + effets locaux": score(with_effects),
        "serrees": {
            "n": int(close.sum()),
            "aucun changement": float((no_change[close] == actual_winner[close]).mean()),
            "swing national seul": float((uniform[close] == actual_winner[close]).mean()),
            "swing + effets locaux": float((with_effects[close] == actual_winner[close]).mean()),
        },
    }


if __name__ == "__main__":
    import warnings

    warnings.filterwarnings("ignore")
    con = duckdb.connect("data/polls.duckdb")
    out = run(con, Path("data/raw"))
    close = out.pop("serrees")

    print("Backtest sur 2018 (le modele n'a jamais vu cette election)\n")
    for label, s in out.items():
        print(f"{label:24s} {s['correct']:>3d}/{s['n']}  ({s['accuracy']*100:5.1f}%)   erreur de sieges {s['seat_error']:>3d}")

    print(f"\nCirconscriptions serrees en 2014 (marge <10 pts) : {close.pop('n')}")
    for label, acc in close.items():
        print(f"  {label:24s} {acc*100:5.1f}%")
    con.close()
