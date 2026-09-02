/**
 * Joint national+regional trend GP -- aggregated observations, one latent
 * trajectory per region per ILR coordinate.
 *
 * f_r(t) = g(t) + h_r(t): g the common provincial movement, h_r independent
 * regional departures. A national poll observes sum_r w_r f_r(t) (w = vote
 * weights); a regional poll observes one f_r directly. Linear functionals of
 * a GP stay Gaussian, so both enter one closed-form posterior -- regional
 * data is INGESTED by the model, not bolted on as a correction afterward.
 *
 * Validated on 2022 (Python prototype, model/regional_gp.py): predicting
 * each region's shares at the election from data available then, MAE 3.06pp
 * vs 3.61pp for uniform swing -- with the gain concentrated in the Quebec
 * City region (3.8 vs 5.6), where the PCQ concentration decides seats and
 * where the uniform swing is most wrong.
 *
 * The g-kernel hyperparameters are inherited per coordinate from the
 * national trend fit (gpTrend chosenHyperparams) rather than re-searched;
 * only the regional kernel (var_h, ls_h) is selected here, by log marginal
 * likelihood. Regional observation noise is sampling-theory (~3/n), NOT the
 * national fitted scale: the national scale absorbs house scatter across
 * hundreds of rows and, applied to a handful of regional rows, it crushed
 * them (effective shrinkage 0.07 where the 2022 calibration measured 0.93).
 */

import { mva, core } from "@tangent.to/ds";
import { toClosedComposition } from "./compositional.js";

const { ilr } = mva.composition;
const { cholesky, choleskySolve } = core.linalg;

export const REGIONS = ["MTL", "QC", "REG"];
const VAR_H_GRID = [0.02, 0.08, 0.2, 0.5];
const LS_H_GRID = [400, 1000];

function matern32(ta, tb, ls) {
  const K = [];
  for (const a of ta) {
    const row = [];
    for (const b of tb) {
      const s = (Math.sqrt(3) * Math.abs(a - b)) / ls;
      row.push((1 + s) * Math.exp(-s));
    }
    K.push(row);
  }
  return K;
}

class JointGP {
  constructor(weights, lsG, varG, lsH, varH) {
    this.w = weights;
    this.lsG = lsG; this.varG = varG; this.lsH = lsH; this.varH = varH;
  }

  _cross(kindsA, tA, kindsB, tB) {
    const Kg = matern32(tA, tB, this.lsG);
    const Kh = matern32(tA, tB, this.lsH);
    const wsq = REGIONS.reduce((s, r) => s + this.w[r] * this.w[r], 0);
    const C = [];
    for (let i = 0; i < tA.length; i++) {
      const row = [];
      for (let j = 0; j < tB.length; j++) {
        const g = this.varG * Kg[i][j], h = this.varH * Kh[i][j];
        const ka = kindsA[i], kb = kindsB[j];
        if (ka === "nat" && kb === "nat") row.push(g + wsq * h);
        else if (ka === "nat") row.push(g + this.w[kb] * h);
        else if (kb === "nat") row.push(g + this.w[ka] * h);
        else row.push(g + (ka === kb ? h : 0));
      }
      C.push(row);
    }
    return C;
  }

  fit(t, kinds, y, noise) {
    this.t = t; this.kinds = kinds;
    this.mean = y.reduce((a, b) => a + b, 0) / y.length;
    const K = this._cross(kinds, t, kinds, t);
    for (let i = 0; i < K.length; i++) K[i][i] += noise[i] + 1e-9;
    this.L = cholesky(core.linalg.toMatrix(K));
    const centered = y.map((v) => v - this.mean);
    this.alpha = choleskySolve(this.L, centered);
    let quad = 0;
    for (let i = 0; i < y.length; i++) quad += centered[i] * (Array.isArray(this.alpha) ? this.alpha[i] : this.alpha.get(i, 0));
    let logDet = 0;
    for (let i = 0; i < y.length; i++) logDet += Math.log(this.L.get(i, i));
    this.lml = -0.5 * quad - logDet - 0.5 * y.length * Math.log(2 * Math.PI);
    return this;
  }

  predictRegion(region, tStar) {
    const ks = this._cross([region], [tStar], this.kinds, this.t)[0];
    let m = this.mean;
    for (let i = 0; i < ks.length; i++) m += ks[i] * (Array.isArray(this.alpha) ? this.alpha[i] : this.alpha.get(i, 0));
    return m;
  }
}

/**
 * @param {Array} nationalPolls pivoted national polls (from pivotPolls)
 * @param {Array} regionalRows long-format regional rows (qc_regional_polls.json)
 * @param {Object} natHyper per-coordinate {lengthScale, noiseScale} from fitTrend
 * @param {Object} weights {MTL, QC, REG} vote weights
 * @returns {{predictDeviation(asOf): Object<region, number[]>}} ILR deviation
 *          of each region from the national trend, at asOf
 */
export function fitRegionalTrend(nationalPolls, regionalRows, partyCodes, natHyper, weights) {
  // Pivot regional rows: one observation per (poll_id) with its region.
  const byPoll = new Map();
  for (const r of regionalRows) {
    if (!byPoll.has(r.poll_id)) {
      byPoll.set(r.poll_id, {
        pollDate: r.poll_date, region: r.region_code ?? r.region, sampleSize: r.sample_size,
        shares: Object.fromEntries(partyCodes.map((p) => [p, null])),
      });
    }
    byPoll.get(r.poll_id).shares[r.party_code] = r.pct_reported / 100;
  }
  const regionals = [...byPoll.values()].filter((p) => REGIONS.includes(p.region));

  const t0 = nationalPolls.reduce((min, p) => (p.pollDate < min ? p.pollDate : min), nationalPolls[0].pollDate);
  const day = (d) => (new Date(d) - new Date(t0)) / 86_400_000;

  const natComp = toClosedComposition(nationalPolls, partyCodes);
  const natIlr = ilr(natComp);
  const regComp = regionals.length ? toClosedComposition(regionals, partyCodes) : [];
  const regIlr = regionals.length ? ilr(regComp) : [];

  const t = [...nationalPolls.map((p) => day(p.pollDate)), ...regionals.map((p) => day(p.pollDate))];
  const kinds = [...nationalPolls.map(() => "nat"), ...regionals.map((p) => p.region)];

  const k = natIlr[0].length;
  const gps = [];
  for (let c = 0; c < k; c++) {
    const y = [...natIlr.map((row) => row[c]), ...regIlr.map((row) => row[c])];
    // Empirical variance of the national series anchors the g amplitude.
    const meanY = y.reduce((a, b) => a + b, 0) / y.length;
    const varG = Math.max(natIlr.map((r) => r[c]).reduce((s, v) => s + (v - meanY) ** 2, 0) / natIlr.length, 1e-4);
    const { lengthScale, noiseScale } = natHyper[c];
    const noise = [
      ...nationalPolls.map((p) => noiseScale / Math.max(p.sampleSize > 0 ? p.sampleSize / 1000 : 1, 0.05)),
      ...regionals.map((p) => 3.0 / Math.max(p.sampleSize ?? 800, 100)),
    ];

    let best = null;
    for (const lsH of LS_H_GRID) {
      for (const varH of VAR_H_GRID) {
        const gp = new JointGP(weights, lengthScale, varG, lsH, varH);
        try {
          gp.fit(t, kinds, y, noise);
        } catch {
          continue;
        }
        if (!best || gp.lml > best.lml) best = gp;
      }
    }
    gps.push(best);
  }

  return {
    nRegionalPolls: regionals.length,
    predictDeviation(asOf) {
      const tStar = day(asOf);
      const out = {};
      for (const region of REGIONS) {
        const dev = [];
        for (let c = 0; c < k; c++) {
          const gp = gps[c];
          if (!gp) { dev.push(0); continue; }
          const fr = gp.predictRegion(region, tStar);
          // National trajectory implied by the same model: vote-weighted mix.
          const fn = REGIONS.reduce((s, r) => s + weights[r] * gp.predictRegion(r, tStar), 0);
          dev.push(fr - fn);
        }
        out[region] = dev;
      }
      return out;
    },
  };
}
