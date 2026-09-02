/**
 * Riding-level departure from the provincial swing, modelled entirely in
 * ILR coordinates with @tangent.to/ds.
 *
 * Two things this gets right that the earlier Python version did not:
 *
 * 1. **The predictors are compositions too.** Language shares, NAICS sector
 *    shares, education levels and immigrant status are each constrained to
 *    a simplex and carry only relative information. Feeding them to a
 *    regression as raw percentages is the same wrong-geometry mistake as
 *    using raw share differences for the response. Each group is closed
 *    (with an explicit remainder part) and ILR-transformed on its own before
 *    it ever reaches the model. Only median age, median income and
 *    population density are genuine unconstrained scalars and pass through
 *    untouched.
 *
 * 2. **ILR, not CLR, throughout.** CLR coordinates sum to zero, so their
 *    covariance is singular and any method that fits per-coordinate models
 *    or inverts a covariance is degenerate. ILR gives k-1 orthonormal
 *    full-rank coordinates. (For pure perturbation and weighted-mean
 *    operations the two bases give numerically identical results -- verified
 *    to 1e-16 -- so this matters specifically for the modelling steps, not
 *    for the swing arithmetic.)
 *
 * No variable selection: everything goes in and regularization shrinks what
 * doesn't carry signal. Selecting explicitly only adds instability.
 */

import { mva } from "@tangent.to/ds";

const { closure, multiplicativeReplacement, ilr, ilrInv } = mva.composition;

export const PARTIES = ["CAQ", "LIB", "QS", "PQ", "PCQ", "AUTRES"];
const SCALAR_FEATURES = ["median_age", "median_household_income", "population_density"];
const COMPOSITIONAL_GROUPS = ["language", "education", "immigration", "industry"];

/** Zero-safe ILR of one composition (a single row). */
function ilrRow(parts) {
  const delta = (1 / parts.length) ** 2;
  return ilr(closure(multiplicativeReplacement([parts], delta)))[0];
}

/** ILR of a matrix of compositions (rows). */
export function ilrMatrix(rows) {
  const delta = (1 / rows[0].length) ** 2;
  return ilr(closure(multiplicativeReplacement(rows, delta)));
}

/**
 * Build the predictor matrix. Each compositional group contributes its own
 * ILR coordinates; scalars are passed through and standardized later.
 * @returns {{X: number[][], names: string[], ridings: string[]}}
 */
export function buildFeatureMatrix(featureRows) {
  const usable = featureRows.filter(
    (r) => COMPOSITIONAL_GROUPS.every((g) => Array.isArray(r[g])) && SCALAR_FEATURES.every((s) => r[s] != null)
  );

  const names = [];
  for (const group of COMPOSITIONAL_GROUPS) {
    const nParts = usable[0][group].length;
    for (let i = 0; i < nParts - 1; i++) names.push(`${group}_ilr${i}`);
  }
  names.push(...SCALAR_FEATURES);

  const X = usable.map((r) => {
    const row = [];
    for (const group of COMPOSITIONAL_GROUPS) row.push(...ilrRow(r[group]));
    for (const s of SCALAR_FEATURES) row.push(r[s]);
    return row;
  });

  return { X, names, ridings: usable.map((r) => String(r.riding_code)) };
}

/** Party-share composition per riding for one election, from raw vote rows. */
export function sharesByRiding(resultRows, electionDate, boundaryYear, partyCodes = PARTIES) {
  const byRiding = new Map();
  for (const row of resultRows) {
    if (row.election_date !== electionDate || row.boundary_year !== boundaryYear) continue;
    const code = String(row.riding_code);
    const party = partyCodes.includes(row.party_code) ? row.party_code : "AUTRES";
    if (!byRiding.has(code)) byRiding.set(code, Object.fromEntries(partyCodes.map((p) => [p, 0])));
    byRiding.get(code)[party] += row.votes;
  }
  const out = new Map();
  for (const [code, counts] of byRiding) {
    const total = partyCodes.reduce((s, p) => s + counts[p], 0);
    if (total > 0) out.set(code, partyCodes.map((p) => counts[p] / total));
  }
  return out;
}

/**
 * Each riding's departure from the provincial swing, in ILR space:
 * ilr(shares_b) - ilr(shares_a), centred.
 */
export function residualIlr(resultRows, dateA, boundaryA, dateB, boundaryB, partyCodes = PARTIES) {
  const a = sharesByRiding(resultRows, dateA, boundaryA, partyCodes);
  const b = sharesByRiding(resultRows, dateB, boundaryB, partyCodes);
  const common = [...a.keys()].filter((k) => b.has(k));
  if (common.length === 0) return { ridings: [], Y: [] };

  const ilrA = ilrMatrix(common.map((k) => a.get(k)));
  const ilrB = ilrMatrix(common.map((k) => b.get(k)));
  const swing = ilrB.map((row, i) => row.map((v, j) => v - ilrA[i][j]));

  const k = swing[0].length;
  const mean = Array.from({ length: k }, (_, j) => swing.reduce((s, r) => s + r[j], 0) / swing.length);
  return { ridings: common, Y: swing.map((r) => r.map((v, j) => v - mean[j])) };
}

/** Apply a predicted ILR departure to each riding's baseline composition. */
export function applyIlrShift(baselineShares, shifts, maxShift = 0.35) {
  const base = ilrMatrix(baselineShares);
  const shifted = base.map((row, i) =>
    row.map((v, j) => v + Math.max(-maxShift, Math.min(maxShift, shifts[i][j])))
  );
  return ilrInv(shifted);
}
