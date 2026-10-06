/**
 * Test: anisotropy of the systemic shock (five-agent review, 2026-10-06).
 *
 * The simulation's industry shock is isotropic in ILR by construction --
 * amplitude estimated, direction uniform on the sphere. The three
 * observed final-polls->result drifts (2018, 2022, 2026) are the only
 * data on its direction. Alternative on a grid:
 *
 *   Sigma(gamma) = sigma^2 [ (1-gamma) I + gamma k v v^T ],  trace-preserving,
 *
 * v = leading principal axis of the TRAINING drifts, gamma = 0 the
 * production null. Leave-one-election-out: v and sigma^2 from two drifts,
 * log-density of the held-out drift under N(0, Sigma(gamma)). A covariance
 * test has more power at n=3 than the mean test that (correctly) kept the
 * zero-mean assumption.
 *
 * Drifts are computed exactly as in final_poll_errors.mjs: industry mean
 * of each firm's final poll minus the official result, in full 6-part ILR.
 *
 * Run: node js/tools/anisotropy_test.mjs   (from the repo root)
 */

import { readFileSync } from "node:fs";
import { mva } from "@tangent.to/ds";
import { pivotPolls, toClosedComposition } from "../src/compositional.js";

const { ilr } = mva.composition;

// Sub-composition stable across eras: the four parties present at every
// election plus an amalgamated rest (PCQ at 1.5% in 2018 blows up the
// 6-part log-ratios and would dominate the axis estimate spuriously).
const SUB = ["CAQ", "LIB", "PQ", "QS"];
const toSub = (shares) => {
  const rest = 100 - SUB.reduce((s, p) => s + (shares[p] ?? 0), 0);
  return Object.fromEntries([...SUB.map((p) => [p, shares[p] ?? 0]), ["RESTE", Math.max(rest, 0.2)]]);
};

const ELECTIONS = {
  2018: { window: ["2018-09-17", "2018-10-01"], actual: { CAQ: 37.42, LIB: 24.82, QS: 16.10, PQ: 17.06, PCQ: 1.46, AUTRES: 3.14 } },
  2022: { window: ["2022-09-19", "2022-10-03"], actual: { CAQ: 40.98, LIB: 14.37, QS: 15.43, PQ: 14.61, PCQ: 12.91, AUTRES: 1.70 } },
  2026: { window: ["2026-09-21", "2026-10-05"], actual: { CAQ: 13.3453, LIB: 24.2157, QS: 12.4266, PQ: 28.0189, PCQ: 20.6691, AUTRES: 1.3244 } },
};

const rows = JSON.parse(readFileSync(new URL("../data/qc_national_polls.json", import.meta.url), "utf-8"));
const { polls, partyCodes } = pivotPolls(rows);
const SUBCODES = [...SUB, "RESTE"];
const toIlr = (sharesPct) => {
  const sub = toSub(sharesPct);
  const rec = [{ shares: Object.fromEntries(SUBCODES.map((p) => [p, sub[p] / 100])) }];
  return ilr(toClosedComposition(rec, SUBCODES))[0];
};

// industry drift per election
const drifts = {};
for (const [year, cfg] of Object.entries(ELECTIONS)) {
  const finals = new Map();
  for (const p of polls) {
    if (p.pollDate < cfg.window[0] || p.pollDate > cfg.window[1]) continue;
    const cur = finals.get(p.firm);
    if (!cur || p.pollDate > cur.pollDate) finals.set(p.firm, p);
  }
  const vecs = [...finals.values()].map((p) => {
    const pct = Object.fromEntries(partyCodes.map((c) => [c, (p.shares[c] ?? 0) * 100]));
    return toIlr(pct);
  });
  const res = toIlr(cfg.actual);
  const k = res.length;
  drifts[year] = Array.from({ length: k }, (_, j) =>
    vecs.reduce((s, v) => s + v[j], 0) / vecs.length - res[j]);
}
const years = Object.keys(drifts);
const k = drifts[years[0]].length;
console.log("derives d'industrie (ILR 6 parts) :");
for (const y of years) console.log(`  ${y} : [${drifts[y].map((v) => v.toFixed(3)).join(", ")}]  norme ${Math.hypot(...drifts[y]).toFixed(3)}`);

const GAMMA = [0, 0.3, 0.6];
const loo = (held) => {
  const train = years.filter((y) => y !== held).map((y) => drifts[y]);
  // leading axis of the two training drifts
  const S = Array.from({ length: k }, () => new Array(k).fill(0));
  for (const d of train) for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) S[i][j] += d[i] * d[j];
  // leading axis by power iteration (rank <= 2 matrix, converges fast)
  let u = new Array(k).fill(1 / Math.sqrt(k));
  for (let it = 0; it < 50; it++) {
    const w = S.map((row) => row.reduce((s2, v2, j) => s2 + v2 * u[j], 0));
    const nw = Math.hypot(...w) || 1;
    u = w.map((x) => x / nw);
  }
  // per-coordinate variance from training norms (trace/k per obs)
  const s2 = train.reduce((s, d) => s + d.reduce((t, x) => t + x * x, 0), 0) / (train.length * k);

  const x = drifts[held];
  const proj = x.reduce((s, xi, i) => s + xi * u[i], 0);
  const out = {};
  for (const g of GAMMA) {
    // eigen-structure: variance s2(1-g) off-axis, s2((1-g)+gk) on axis u
    const lamOff = s2 * (1 - g) || 1e-12;
    const lamOn = s2 * ((1 - g) + g * k);
    const q = (x.reduce((s, xi) => s + xi * xi, 0) - proj * proj) / lamOff + (proj * proj) / lamOn;
    const ld = (k - 1) * Math.log(lamOff) + Math.log(lamOn);
    out[g] = -0.5 * (q + ld + k * Math.log(2 * Math.PI));
  }
  return out;
};

console.log("\nlog-densite LOO de la derive tenue a l'ecart (plus haut = mieux) :");
const totals = Object.fromEntries(GAMMA.map((g) => [g, 0]));
for (const y of years) {
  const r = loo(y);
  for (const g of GAMMA) totals[g] += r[g];
  console.log(`  ${y} tenu : ` + GAMMA.map((g) => `g=${g}: ${r[g].toFixed(2)}`).join("   "));
}
console.log("  TOTAL   : " + GAMMA.map((g) => `g=${g}: ${totals[g].toFixed(2)}`).join("   "));
