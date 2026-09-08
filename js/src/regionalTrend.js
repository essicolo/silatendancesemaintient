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
 * Since @tangent.to/ds 0.13 the GP itself is the library's: the aggregation
 * structure is entirely expressible as a KERNEL over augmented inputs
 * [day, kind] (kind = national or one region), because the covariance
 * between any two observations -- national x national, national x regional,
 * regional x regional -- is a fixed formula in k_g and k_h. So the custom
 * code here is a Kernel subclass; fitting, factorization, marginal
 * likelihood and prediction are GaussianProcessRegressor with a
 * per-observation noise vector (alpha).
 *
 * Validated on 2022 (Python prototype, model/regional_gp.py): predicting
 * each region's shares at the election from data available then, MAE 3.06pp
 * vs 3.61pp for uniform swing -- with the gain concentrated in the Quebec
 * City region (3.8 vs 5.6), where the PCQ concentration decides seats and
 * where the uniform swing is most wrong.
 *
 * The g-kernel hyperparameters -- length scale AND campaign clock dilation
 * -- are inherited per coordinate from the national trend fit (gpTrend
 * chosenHyperparams) rather than re-searched;
 * only the regional kernel (var_h, ls_h) is selected here, by log marginal
 * likelihood. Regional observation noise is sampling-theory (~3/n), NOT the
 * national fitted scale: the national scale absorbs house scatter across
 * hundreds of rows and, applied to a handful of regional rows, it crushed
 * them (effective shrinkage 0.07 where the 2022 calibration measured 0.93).
 */

import { ml, mva } from "@tangent.to/ds";
import { toClosedComposition } from "./compositional.js";
import { toX } from "./gpTrend.js";

const { ilr } = mva.composition;

export const REGIONS = ["MTL", "QC", "REG"];
const VAR_H_GRID = [0.02, 0.08, 0.2, 0.5];
const LS_H_GRID = [400, 1000];

// Input-row encoding for the augmented space: [day, kind].
const KIND_NAT = -1;
const kindOf = (region) => (region === "nat" ? KIND_NAT : REGIONS.indexOf(region));

const matern32 = (d, ls) => {
  const s = (Math.sqrt(3) * Math.abs(d)) / ls;
  return (1 + s) * Math.exp(-s);
};

/** Covariance of the aggregated-observation model, as a kernel over
 * [day, kind] rows. With Kg = varG k_g and Kh = varH k_h:
 *   nat x nat   : Kg + (sum_r w_r^2) Kh
 *   nat x reg r : Kg + w_r Kh
 *   reg r x reg s: Kg + [r == s] Kh
 */
class AggregatedRegionalKernel extends ml.Kernel {
  constructor({ weights, lsG, varG, lsH, varH }) {
    super();
    this.weights = weights; // per REGIONS order
    this.lsG = lsG; this.varG = varG; this.lsH = lsH; this.varH = varH;
    this.wsq = weights.reduce((s, w) => s + w * w, 0);
  }

  compute(a, b) {
    const g = this.varG * matern32(a[0] - b[0], this.lsG);
    const h = this.varH * matern32(a[0] - b[0], this.lsH);
    const ka = a[1], kb = b[1];
    if (ka === KIND_NAT && kb === KIND_NAT) return g + this.wsq * h;
    if (ka === KIND_NAT) return g + this.weights[kb] * h;
    if (kb === KIND_NAT) return g + this.weights[ka] * h;
    return g + (ka === kb ? h : 0);
  }

  getParams() {
    return { weights: this.weights, lsG: this.lsG, varG: this.varG, lsH: this.lsH, varH: this.varH };
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

  const natComp = toClosedComposition(nationalPolls, partyCodes);
  const natIlr = ilr(natComp);
  const regComp = regionals.length ? toClosedComposition(regionals, partyCodes) : [];
  const regIlr = regionals.length ? ilr(regComp) : [];

  // The joint GP runs on the SAME campaign-dilated clock as the national
  // trend it inherits its g-kernel from (gpTrend's toX carries [day, regime,
  // campaignDays]). The dilation factor is per ILR coordinate, so the warped
  // time axis is built inside the coordinate loop; both g and h_r see the
  // warped axis -- regional dynamics accelerate in a campaign too, and a
  // mixed clock would make the inherited length scale mean two different
  // things in the same covariance.
  const baseRows = toX(t0, [
    ...nationalPolls.map((p) => p.pollDate),
    ...regionals.map((p) => p.pollDate),
  ]);
  const kinds = [
    ...nationalPolls.map(() => KIND_NAT),
    ...regionals.map((p) => kindOf(p.region)),
  ];
  const wVec = REGIONS.map((r) => weights[r]);

  const k = natIlr[0].length;
  const gps = [];
  for (let c = 0; c < k; c++) {
    const y = [...natIlr.map((row) => row[c]), ...regIlr.map((row) => row[c])];
    // Empirical variance of the national series anchors the g amplitude.
    const meanY = y.reduce((a, b) => a + b, 0) / y.length;
    const varG = Math.max(natIlr.map((r) => r[c]).reduce((s, v) => s + (v - meanY) ** 2, 0) / natIlr.length, 1e-4);
    const { lengthScale, noiseScale, dilation = 1 } = natHyper[c];
    const x = baseRows.map(([d, , camp], i) => [d + (dilation - 1) * camp, kinds[i]]);
    const noise = [
      ...nationalPolls.map((p) => noiseScale / Math.max(p.sampleSize > 0 ? p.sampleSize / 1000 : 1, 0.05)),
      ...regionals.map((p) => 3.0 / Math.max(p.sampleSize ?? 800, 100)),
    ];

    let best = null;
    for (const lsH of LS_H_GRID) {
      for (const varH of VAR_H_GRID) {
        // normalizeY would rescale y by its std and leave alpha (raw ILR
        // variance units) on the wrong scale; the kernel amplitude varG is
        // already anchored on the data, so only centering is needed, and the
        // GP handles that itself with normalizeY: false plus a centered y.
        const gp = new ml.GaussianProcessRegressor({
          kernel: new AggregatedRegionalKernel({ weights: wVec, lsG: lengthScale, varG, lsH, varH }),
          normalizeY: false,
        });
        try {
          gp.fit(x, y.map((v) => v - meanY), { alpha: noise });
        } catch {
          continue;
        }
        if (!best || gp.logMarginalLikelihood_ > best.lml) {
          best = { gp, mean: meanY, lml: gp.logMarginalLikelihood_, dilation };
        }
      }
    }
    gps.push(best);
  }

  return {
    nRegionalPolls: regionals.length,
    predictDeviation(asOf) {
      const [dStar, , campStar] = toX(t0, [asOf])[0];
      const out = {};
      const predictKind = (gp, kind) =>
        gp.gp.predict([[dStar + (gp.dilation - 1) * campStar, kind]])[0] + gp.mean;
      for (const region of REGIONS) {
        const dev = [];
        for (let c = 0; c < k; c++) {
          const gp = gps[c];
          if (!gp) { dev.push(0); continue; }
          const fr = predictKind(gp, kindOf(region));
          // National trajectory implied by the same model: vote-weighted mix.
          const fn = REGIONS.reduce((s, r) => s + weights[r] * predictKind(gp, kindOf(r)), 0);
          dev.push(fr - fn);
        }
        out[region] = dev;
      }
      return out;
    },
  };
}
