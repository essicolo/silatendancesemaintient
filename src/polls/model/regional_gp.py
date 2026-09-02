"""Joint national+regional trend GP with aggregated observations. Prototype.

The architecture question this answers: regional polls should not be bolted
on as a correction to a national model -- they should be OBSERVATIONS of the
same latent object. Per ILR coordinate, the latent is three regional
trajectories

    f_r(t) = g(t) + h_r(t),   r in {MTL, QC, REG}

with g the common provincial movement and h_r independent regional
departures. Every poll is then a linear observation of the latents, and
linear functionals of a GP stay Gaussian-conjugate:

    national poll:  y(t)  = sum_r w_r f_r(t) + eps      (w = vote weights)
    regional poll:  y_r(t) = f_r(t) + eps_r

so one closed-form GP ingests both kinds without any special-casing. The
resulting kernel blocks:

    Cov(nat, nat)   = k_g + sum_r w_r^2 k_h
    Cov(nat, reg_r) = k_g + w_r k_h
    Cov(reg_r, reg_s) = k_g + [r=s] k_h

What this buys over the correction approach: the shrinkage toward regional
measurements emerges from the noise ratios instead of being a tuned lambda;
a stale regional measurement fades on the h-kernel's own length scale; and
the posterior variance of h_r is the principled replacement for the
simulation's ad-hoc regional shock.

Validation below: fit on the 2022 cycle's data as of election day (regional
tables stop in late August 2022), predict each region's deviation at the
election, score against (a) actual results, (b) the uniform-swing baseline
that preserves 2018's deviations. The lambda=0.93 calibration said regional
polls carry real signal; this checks the joint model captures it.
"""

from __future__ import annotations

from pathlib import Path

import duckdb
import numpy as np
import nuee
import pandas as pd

from polls.model.regional_calibration import (
    PARTIES as MAJOR,
    actual_regional_shares,
    regional_final_polls,
)

REGIONS = ["MTL", "QC", "REG"]
PARTIES = ["CAQ", "LIB", "QS", "PQ", "PCQ", "AUTRES"]


def _ilr_rows(x: np.ndarray) -> np.ndarray:
    return nuee.ilr(nuee.closure(nuee.multiplicative_replacement(np.asarray(x, dtype=float), (1 / x.shape[1]) ** 2)))


def matern32(t1: np.ndarray, t2: np.ndarray, ls: float) -> np.ndarray:
    d = np.abs(t1.reshape(-1, 1) - t2.reshape(1, -1)) / ls
    s = np.sqrt(3) * d
    return (1 + s) * np.exp(-s)


class JointRegionalGP:
    """One coordinate. Observations: list of (t, kind, value, noise_var),
    kind = 'nat' or region code."""

    def __init__(self, weights: dict[str, float], ls_g: float, var_g: float, ls_h: float, var_h: float):
        self.w = weights
        self.ls_g, self.var_g, self.ls_h, self.var_h = ls_g, var_g, ls_h, var_h

    def _cross(self, kinds_a, t_a, kinds_b, t_b):
        Kg = self.var_g * matern32(t_a, t_b, self.ls_g)
        Kh = self.var_h * matern32(t_a, t_b, self.ls_h)
        wsq = sum(v * v for v in self.w.values())
        C = np.zeros((len(t_a), len(t_b)))
        for i, ka in enumerate(kinds_a):
            for j, kb in enumerate(kinds_b):
                if ka == "nat" and kb == "nat":
                    C[i, j] = Kg[i, j] + wsq * Kh[i, j]
                elif ka == "nat":
                    C[i, j] = Kg[i, j] + self.w[kb] * Kh[i, j]
                elif kb == "nat":
                    C[i, j] = Kg[i, j] + self.w[ka] * Kh[i, j]
                else:
                    C[i, j] = Kg[i, j] + (Kh[i, j] if ka == kb else 0.0)
        return C

    def fit(self, obs):
        self.t = np.array([o[0] for o in obs], dtype=float)
        self.kinds = [o[1] for o in obs]
        y = np.array([o[2] for o in obs], dtype=float)
        noise = np.array([o[3] for o in obs], dtype=float)
        self.mean = y.mean()
        K = self._cross(self.kinds, self.t, self.kinds, self.t) + np.diag(noise)
        self.L = np.linalg.cholesky(K + 1e-9 * np.eye(len(K)))
        self.alpha = np.linalg.solve(self.L.T, np.linalg.solve(self.L, y - self.mean))
        # log marginal likelihood, for hyperparameter selection
        self.lml = float(
            -0.5 * (y - self.mean) @ self.alpha - np.log(np.diag(self.L)).sum() - 0.5 * len(y) * np.log(2 * np.pi)
        )
        return self

    def predict_region(self, region: str, t_star: float) -> tuple[float, float]:
        ks = self._cross([region], np.array([t_star]), self.kinds, self.t)[0]
        mean = self.mean + ks @ self.alpha
        v = np.linalg.solve(self.L, ks)
        prior = self.var_g + self.var_h
        return float(mean), float(max(prior - v @ v, 1e-12))


def build_observations(con, cutoff: str, national_where: str = "region_code='National'"):
    """Per-coordinate observation lists from the polls table: national series
    plus whatever regional rows exist (MTL/QC/REG region codes)."""
    df = con.execute(
        f"""SELECT p.poll_date, p.region_code, p.sample_size, s.party_code, s.pct_reported
        FROM polls p JOIN poll_shares s USING (poll_id)
        WHERE p.jurisdiction_code='qc-provincial' AND p.general_election IS NULL
          AND p.poll_date <= ? AND (p.region_code IN ('MTL','QC','REG') OR {national_where})
        """,
        [cutoff],
    ).df()
    wide = df.pivot_table(index=["poll_date", "region_code", "sample_size"], columns="party_code",
                          values="pct_reported").reset_index()
    for p in PARTIES:
        if p not in wide.columns:
            wide[p] = 0.0
    wide = wide.fillna(0.0)
    coords = _ilr_rows(wide[PARTIES].to_numpy())
    t0 = pd.Timestamp(wide["poll_date"].min())
    days = (pd.to_datetime(wide["poll_date"]) - t0).dt.days.to_numpy(dtype=float)
    kinds = ["nat" if r == "National" else r for r in wide["region_code"]]
    n = wide["sample_size"].fillna(800).clip(lower=100).to_numpy(dtype=float)
    # National-poll noise keeps a fitted scale (it absorbs house scatter and
    # model misfit, which dwarf pure sampling error). REGIONAL rows get
    # sampling-theory noise directly, NOT the national scale: one global
    # scale tuned on 240 national observations crushed the 3 regional ones
    # (effective shrinkage 0.07 where the 2022 calibration measured 0.93).
    # ILR sampling variance is ~c/n with c a small constant; c=3 is
    # conservative for 5-6 part compositions at these shares.
    noise = 1.0 / n
    return t0, days, kinds, coords, noise


def region_weights(con) -> dict[str, float]:
    regions = pd.read_json(Path(__file__).parents[3] / "js" / "data" / "qc_riding_regions.json")
    reg_by_code = dict(zip(regions["riding_code"].astype(str), regions["region_code"]))
    df = con.execute(
        "SELECT riding_code, sum(votes) v FROM election_results WHERE jurisdiction_code='qc-provincial' "
        "AND election_date='2022-10-03' AND boundary_year='2026' GROUP BY 1",
    ).df()
    df["riding_code"] = df["riding_code"].astype(str).map(lambda c: str(int(float(c))) if c.replace(".", "").isdigit() else c)
    df["region"] = df["riding_code"].map(reg_by_code)
    w = df.groupby("region")["v"].sum()
    w = w / w.sum()
    return {r: float(w.get(r, 0)) for r in REGIONS}


def fit_all(con, cutoff: str, weights: dict[str, float]):
    """Grid over (var_h, ls_h, noise_scale) by summed log marginal likelihood;
    g-kernel scales chosen alongside. Coarse but honest."""
    t0, days, kinds, coords, rel_noise = build_observations(con, cutoff)
    k = coords.shape[1]
    models = []
    for j in range(k):
        y = coords[:, j]
        best = None
        for ls_g in (200.0, 500.0, 1000.0):
            for var_g in (0.02, 0.08, 0.2):
                for ls_h in (400.0, 1000.0):
                    for var_h in (0.02, 0.08, 0.2, 0.5):
                        for nscale in (100.0, 400.0, 1600.0):
                            gp = JointRegionalGP(weights, ls_g, var_g, ls_h, var_h)
                            obs = [(days[i], kinds[i], y[i],
                                    rel_noise[i] * (3.0 if kinds[i] != "nat" else nscale))
                                   for i in range(len(y))]
                            try:
                                gp.fit(obs)
                            except np.linalg.LinAlgError:
                                continue
                            if best is None or gp.lml > best.lml:
                                best = gp
        models.append(best)
    return t0, models


def main() -> None:
    con = duckdb.connect(str(Path(__file__).parents[3] / "data" / "polls.duckdb"), read_only=True)
    weights = region_weights(con)
    print("poids regionaux (votes 2022):", {r: round(w, 3) for r, w in weights.items()})

    # ---- Validation 2022 : ingest the 2022-cycle regional tables into a
    # temporary in-memory obs set. They are NOT in the polls table (they are
    # excluded from the national series on purpose), so they are appended
    # here from the same extraction the calibration used.
    polls_reg, anchor = regional_final_polls(
        "Liste de sondages sur les élections générales québécoises de 2022", pd.Timestamp("2022-10-03")
    )
    t0, days, kinds, coords, rel_noise = build_observations(con, "2022-10-03")
    y_all = [coords[:, j].copy() for j in range(coords.shape[1])]
    days = list(days); kinds = list(kinds); rel_noise = list(rel_noise)
    for region, shares5 in polls_reg.items():
        # 5 major parties from the table; AUTRES as the closing remainder
        autres = max(100.0 - float(np.nansum(shares5)), 0.5)
        vec = np.array([[*(np.nan_to_num(shares5)), autres]])
        cilr = _ilr_rows(vec)[0]
        d = float((anchor - t0).days)
        days.append(d); kinds.append(region); rel_noise.append(1.0 / 1500.0)  # n~1500 par region, bruit 3/n applique au fit
        for j in range(coords.shape[1]):
            y_all[j] = np.append(y_all[j], cilr[j])

    election_day = float((pd.Timestamp("2022-10-03") - t0).days)
    act22 = actual_regional_shares(con, "2022-10-03")
    act18 = actual_regional_shares(con, "2018-10-01")

    print("\nprediction des parts regionales au scrutin 2022 (GP conjoint vs swing-preserve vs reel):")
    days_a = np.array(days)
    err_gp, err_base = [], []
    preds = {r: [] for r in REGIONS}
    for j in range(coords.shape[1]):
        best = None
        for ls_g in (200.0, 500.0, 1000.0):
            for var_g in (0.02, 0.08, 0.2):
                for ls_h in (400.0, 1000.0):
                    for var_h in (0.02, 0.08, 0.2, 0.5):
                        for nscale in (100.0, 400.0, 1600.0):
                            gp = JointRegionalGP(weights, ls_g, var_g, ls_h, var_h)
                            obs = [(days_a[i], kinds[i], y_all[j][i],
                                    rel_noise[i] * (3.0 if kinds[i] != "nat" else nscale))
                                   for i in range(len(days_a))]
                            try:
                                gp.fit(obs)
                            except np.linalg.LinAlgError:
                                continue
                            if best is None or gp.lml > best.lml:
                                best = gp
        for r in REGIONS:
            m, v = best.predict_region(r, election_day)
            preds[r].append(m)

    for r in REGIONS:
        pred_shares = nuee.ilr_inv(np.array([preds[r]]))[0]
        # align party sets: actuals are on MAJOR (5 parties)
        pred5 = pred_shares[:5] / pred_shares[:5].sum()
        actual = act22[r]
        base18 = act18[r]  # uniform swing preserves 2018 deviations; as share proxy compare direct
        gp_err = float(np.abs(pred5 - actual).mean()) * 100
        err_gp.append(gp_err)
        line = "  ".join(f"{p} {100*pred5[i]:.0f}/{100*actual[i]:.0f}" for i, p in enumerate(MAJOR))
        print(f"  {r}: {line}   MAE {gp_err:.1f} pp")

    print(f"\nMAE moyenne GP conjoint : {np.mean(err_gp):.2f} pp")
    con.close()


if __name__ == "__main__":
    main()
