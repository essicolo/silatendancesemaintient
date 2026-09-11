/**
 * Riding-level seat projection: uniform CLR-space swing (JS port of
 * src/polls/model/swing.py -- see that file's docstring for the rationale
 * and the known limitation, uniform swing rather than qc125's own
 * region/demographic-adjusted approach).
 */

import { mva } from "@tangent.to/ds";

const { closure, multiplicativeReplacement, clr, clrInv } = mva.composition;

/** riding_code round-trips through pandas as e.g. "187.0" (float-typed
 * column); the DGEQ shapefile's CO_CEP is a plain int. Normalize both to
 * the same string so they actually join. */
export function normalizeRidingCode(code) {
  return String(Math.round(parseFloat(code)));
}

/**
 * @param {Array<{riding_code, party_code, votes}>} rows
 * @param {string[]} partyCodes
 * @returns {Map<string, number[]>} riding_code -> share vector (order = partyCodes)
 */
export function ridingBaselineFromRows(rows, partyCodes) {
  const byRiding = new Map();
  for (const r of rows) {
    const code = partyCodes.includes(r.party_code) ? r.party_code : "AUTRES";
    const riding = normalizeRidingCode(r.riding_code);
    if (!byRiding.has(riding)) byRiding.set(riding, Object.fromEntries(partyCodes.map((p) => [p, 0])));
    byRiding.get(riding)[code] += r.votes;
  }
  const out = new Map();
  for (const [riding, votesByParty] of byRiding) {
    const total = partyCodes.reduce((s, p) => s + votesByParty[p], 0);
    out.set(riding, partyCodes.map((p) => votesByParty[p] / total));
  }
  return out;
}

/**
 * Remove the personal incumbency vote from open seats, IN the baseline --
 * before the swing and before the simulation -- so every downstream consumer
 * (point projection, Monte Carlo, watchlist) sees the same adjusted starting
 * point instead of the adjustment living in one path and not the other.
 *
 * A seat is open when its member is not running again, or now sits for
 * another party: in both cases the personal vote inside the previous result
 * will not be on the ballot. The adjustment divides the previous winner's
 * share by `factor` and re-closes -- a perturbation on the simplex, not a
 * percentage-point subtraction. factor = exp(0.118) = 1.125 estimated from
 * the 2018->2022 DGEQ candidate data (log-share excess growth of winners who
 * ran again minus those who didn't; model/incumbency.py), equivalent to
 * ~4.3 points at a typical 40% winning share.
 *
 * @param {Map<string, number[]>} baseline riding_code -> share vector (mutated)
 * @param {Set<string>} openSeatCodes riding codes whose seat is open
 */
/** The personal incumbency vote, estimated 2018->2022 (log-share excess
 * growth of winners who ran again vs those who didn't; model/incumbency.py):
 * exp(0.118) ~= 1.125, i.e. ~4.3 points at a typical 40% winning share.
 * Shared by the open-seat penalty and the by-election departure baseline
 * (byelections.js) so both measure against the same adjusted 2022 result. */
export const INCUMBENCY_FACTOR = Math.exp(0.118);

export function applyOpenSeatPenalty(baseline, openSeatCodes, factor = INCUMBENCY_FACTOR) {
  for (const code of openSeatCodes) {
    const shares = baseline.get(code);
    if (!shares) continue;
    let winner = 0;
    for (let j = 1; j < shares.length; j++) if (shares[j] > shares[winner]) winner = j;
    const adjusted = shares.map((v, j) => (j === winner ? v / factor : v));
    const total = adjusted.reduce((a, b) => a + b, 0);
    baseline.set(code, adjusted.map((v) => v / total));
  }
}

/**
 * Multiply one party's share in one riding by `factor` and re-close -- the
 * elementary perturbation the open-seat and leader adjustments are built
 * from. Because perturbations commute with the (also multiplicative) swing,
 * applying this to the baseline is equivalent to applying it to the final
 * projection, and every consumer of the baseline sees it consistently.
 */
export function applyCompositionFactor(baseline, code, partyIndex, factor) {
  const shares = baseline.get(code);
  if (!shares) return;
  const adjusted = shares.map((v, j) => (j === partyIndex ? v * factor : v));
  const total = adjusted.reduce((a, b) => a + b, 0);
  baseline.set(code, adjusted.map((v) => v / total));
}

export function provinceShareFromRows(rows, partyCodes) {
  const totals = Object.fromEntries(partyCodes.map((p) => [p, 0]));
  for (const r of rows) {
    const code = partyCodes.includes(r.party_code) ? r.party_code : "AUTRES";
    totals[code] += r.votes;
  }
  const sum = partyCodes.reduce((s, p) => s + totals[p], 0);
  return Object.fromEntries(partyCodes.map((p) => [p, totals[p] / sum]));
}

/**
 * riding_forecast_clr = riding_baseline_clr + (province_forecast_clr - province_baseline_clr)
 * @returns {Map<string, {shares: Object<string,number>, winner: string}>}
 */
export function uniformClrSwing(ridingBaseline, provinceBaseline, provinceForecast, partyCodes) {
  const toClr = (shareObj) => {
    const mat = closure(multiplicativeReplacement([partyCodes.map((p) => shareObj[p])], (1 / partyCodes.length) ** 2));
    return clr(mat)[0];
  };
  const baseClr = toClr(provinceBaseline);
  const fcstClr = toClr(provinceForecast);
  const delta = baseClr.map((v, i) => fcstClr[i] - v);

  const out = new Map();
  for (const [riding, shares] of ridingBaseline) {
    const compMat = closure(multiplicativeReplacement([shares], (1 / partyCodes.length) ** 2));
    const ridingClr = clr(compMat)[0];
    const forecastClr = ridingClr.map((v, i) => v + delta[i]);
    const forecastShares = clrInv([forecastClr])[0];
    const sharesObj = Object.fromEntries(partyCodes.map((p, i) => [p, forecastShares[i]]));
    const winner = partyCodes.reduce((best, p) => (sharesObj[p] > sharesObj[best] ? p : best), partyCodes[0]);
    out.set(riding, { shares: sharesObj, winner });
  }
  return out;
}

export function seatProjectionSummary(ridingForecast, partyCodes) {
  const counts = Object.fromEntries(partyCodes.map((p) => [p, 0]));
  for (const { winner } of ridingForecast.values()) counts[winner]++;
  return counts;
}
