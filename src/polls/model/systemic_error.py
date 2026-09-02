"""Estimate the two systemic error terms the seat simulation was missing.

The simulation propagated poll dispersion and riding-level noise, but not the
two terms that historically dominate a seat model's error:

  1. **Industry bias** -- the gap between the final poll aggregate and the
     actual result. It is correlated across every riding (all polls miss in
     the same direction), so it does not average out over 127 seats the way
     independent riding noise does. In Quebec it reached several points on
     the CAQ in both 2018 and 2022.
  2. **Drift** -- the vote moves between today and election day, and a
     posterior evaluated at today's date says nothing about that movement.

Both are estimated here from this database's own polls and results, in ILR
space, and exported as SCALAR (isotropic) standard deviations. Isotropy is a
deliberate choice, not laziness: an isotropic covariance is invariant under
any orthonormal change of basis, so the estimate transfers exactly to the JS
side's ILR basis without having to guarantee that nuee and @tangent.to/ds
construct the same Helmert matrix. With two elections of bias data, a full
covariance would be noise dressed as structure anyway.

Method:
  - Industry bias: weighted aggregate of the final FINAL_WINDOW_DAYS of
    polls before each election vs the actual province-wide result, in ILR;
    sigma_industry = RMS over coordinates and elections.
  - Drift: for all within-cycle pairs of polls (dt in [7, 120] days),
    var(ilr_a - ilr_b) grows as 2*sigma_noise^2 + sigma_daily^2 * dt.
    The slope of a binned linear fit of variance against dt separates the
    random-walk term from the sampling-noise floor.

Output: js/data/qc_systemic.json, consumed by js/src/simulate.js which adds
one common ILR shock per Monte Carlo draw with
sd = sqrt(sigma_industry^2 + sigma_daily2 * days_to_election).
"""

from __future__ import annotations

import json
from pathlib import Path

import duckdb
import numpy as np
import nuee
import pandas as pd

PARTIES = ["CAQ", "LIB", "QS", "PQ", "PCQ", "AUTRES"]
# The error scale is estimated on the MAJOR-party subcomposition. In full
# 6-part ILR the RMS error is dominated by the small-party coordinates --
# the imputed pre-2021 PCQ floor and the AUTRES residual, whose log-ratios
# swing wildly at 1-3% while moving no seats. Estimated on all six parts the
# industry sigma came out at 1.07 ILR, an absurd scale that would double
# party ratios per draw. Subcompositional coherence makes the restriction
# clean: closing [CAQ, LIB, QS, PQ] among themselves and measuring the error
# there captures exactly the ratios that decide seats. The isotropic sd is
# then applied to every coordinate of the full composition in simulate.js --
# minor-party ratios get less systemic variance than history shows, which is
# the harmless direction of that approximation.
MAJOR = ["CAQ", "LIB", "QS", "PQ"]
ELECTIONS = ["2018-10-01", "2022-10-03"]
FINAL_WINDOW_DAYS = 12
OUT_PATH = Path(__file__).parents[3] / "js" / "data" / "qc_systemic.json"


def _ilr(rows: np.ndarray) -> np.ndarray:
    return nuee.ilr(nuee.closure(nuee.multiplicative_replacement(rows, (1 / rows.shape[1]) ** 2)))


def _poll_matrix(con: duckdb.DuckDBPyConnection) -> pd.DataFrame:
    """One row per poll: date, sqrt-n weight, and the closed share vector."""
    df = con.execute(
        """
        SELECT p.poll_id, p.poll_date, p.sample_size, s.party_code, s.pct_reported
        FROM polls p JOIN poll_shares s USING (poll_id)
        WHERE p.jurisdiction_code = 'qc-provincial' AND p.region_code = 'National'
          AND p.general_election IS NULL
        """
    ).df()
    wide = df.pivot_table(index=["poll_id", "poll_date", "sample_size"], columns="party_code", values="pct_reported")
    wide = wide.reindex(columns=PARTIES).fillna(0.0).reset_index()
    wide["weight"] = np.sqrt(wide["sample_size"].fillna(800.0).clip(lower=1))
    return wide


def industry_bias(con: duckdb.DuckDBPyConnection, polls: pd.DataFrame) -> tuple[float, list[dict]]:
    per_election = []
    sq_errors = []
    for election in ELECTIONS:
        edate = pd.Timestamp(election)
        window = polls[(polls["poll_date"] <= edate) & (polls["poll_date"] >= edate - pd.Timedelta(days=FINAL_WINDOW_DAYS))]
        if len(window) < 2:
            continue

        shares = window[MAJOR].to_numpy(dtype=float)
        w = window["weight"].to_numpy()
        ilr_polls = np.average(_ilr(shares), axis=0, weights=w)

        actual = con.execute(
            """
            SELECT party_code, sum(votes) AS v FROM election_results
            WHERE jurisdiction_code='qc-provincial' AND election_date=? AND boundary_year='2017'
            GROUP BY party_code
            """,
            [election],
        ).df()
        by_party = actual.groupby("party_code")["v"].sum()
        result = np.array([by_party.get(p, 0.0) for p in MAJOR], dtype=float)
        ilr_actual = _ilr(result.reshape(1, -1) / result.sum())[0]

        err = ilr_actual - ilr_polls
        sq_errors.extend(err**2)
        per_election.append({"election": election, "n_final_polls": int(len(window)), "rms_ilr": float(np.sqrt((err**2).mean()))})

    sigma = float(np.sqrt(np.mean(sq_errors)))
    return sigma, per_election


def drift_rate(polls: pd.DataFrame) -> tuple[float, dict]:
    """sigma_daily^2 from the slope of pairwise ILR variance against lag."""
    boundaries = [pd.Timestamp(e) for e in ELECTIONS]

    def cycle(date):
        for i, b in enumerate(boundaries):
            if date <= b:
                return i
        return len(boundaries)

    polls = polls.sort_values("poll_date").reset_index(drop=True)
    coords = _ilr(polls[MAJOR].to_numpy(dtype=float))
    dates = polls["poll_date"]
    cycles = dates.map(cycle)

    lags, sqdiffs = [], []
    for i in range(len(polls)):
        for j in range(i + 1, len(polls)):
            if cycles[i] != cycles[j]:
                continue
            dt = (dates[j] - dates[i]).days
            if dt < 7 or dt > 120:
                continue
            d = coords[j] - coords[i]
            lags.append(dt)
            sqdiffs.append(float((d**2).mean()))

    lags, sqdiffs = np.array(lags), np.array(sqdiffs)
    bins = np.array([7, 14, 21, 30, 45, 60, 90, 120])
    bx, by = [], []
    for lo, hi in zip(bins[:-1], bins[1:]):
        mask = (lags >= lo) & (lags < hi)
        if mask.sum() >= 5:
            bx.append(lags[mask].mean())
            by.append(sqdiffs[mask].mean())

    slope, intercept = np.polyfit(bx, by, 1)
    # A negative fitted slope (possible with few bins) would mean "polls
    # converge over time", which is not a usable drift model; floor at zero
    # and let the industry term carry the uncertainty.
    sigma_daily2 = float(max(slope, 0.0))
    return sigma_daily2, {
        "n_pairs": int(len(lags)),
        "noise_floor_ilr2": float(max(intercept, 0.0)),
        "bins_used": len(bx),
    }


def main() -> None:
    con = duckdb.connect(str(Path(__file__).parents[3] / "data" / "polls.duckdb"), read_only=True)
    polls = _poll_matrix(con)
    sigma_industry, per_election = industry_bias(con, polls)
    sigma_daily2, drift_meta = drift_rate(polls)
    con.close()

    payload = {
        "sigma_industry": sigma_industry,
        "sigma_daily2": sigma_daily2,
        "estimated_from": {
            "industry": per_election,
            "drift": drift_meta,
            "note": "isotropic ILR; industry RMS over 2 elections -- a thin base, stated as such",
        },
    }
    OUT_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"sigma_industry = {sigma_industry:.4f} (ILR)")
    for e in per_election:
        print(f"  {e['election']}: {e['n_final_polls']} sondages finaux, RMS {e['rms_ilr']:.4f}")
    print(f"sigma_daily^2  = {sigma_daily2:.6f}  ({drift_meta['n_pairs']} paires, {drift_meta['bins_used']} bins)")
    horizon = 39
    total = np.sqrt(sigma_industry**2 + sigma_daily2 * horizon)
    print(f"exemple: a {horizon} jours du scrutin, sd du choc commun = {total:.4f} ILR")
    print(f"-> {OUT_PATH}")


if __name__ == "__main__":
    main()
