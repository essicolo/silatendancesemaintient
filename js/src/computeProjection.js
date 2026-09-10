/**
 * The full modelling pipeline, headless: poll trend GP, regional joint GP,
 * baseline adjustments (open seats, leader effects), riding-effects GP,
 * Monte Carlo seat simulation. Returns one plain serializable object.
 *
 * This used to run in the browser on every page load (~20s). It now runs
 * once, in Node, when the poll watch detects new data (js/tools/compute.mjs
 * -> data/qc_projection.json), and the page only renders the result. Same
 * code, same library (@tangent.to/ds), different moment of execution -- the
 * page displays results instead of modelling.
 */

import { mva } from "@tangent.to/ds";
import { pivotPolls } from "./compositional.js";
import { fitTrend, predictTrendSeries, predictTrend, sampleTrendDraws } from "./gpTrend.js";
import {
  ridingBaselineFromRows,
  provinceShareFromRows,
  uniformClrSwing,
  normalizeRidingCode,
  applyOpenSeatPenalty,
  applyCompositionFactor,
} from "./swing.js";
import { simulateSeatCounts, seatDistributions, governmentScenarios, medoidDraw } from "./simulate.js";
import { fitRegionalTrend, REGIONS } from "./regionalTrend.js";
import { residualIlr, ilrMatrix } from "./ridingEffects.js";
import { trainRidingEffects, predictRidingEffects } from "./ridingProjection.js";

const ELECTION_DATE = "2026-10-05";

function applyEffectsToForecast(ridingForecast, effects, partyCodes) {
  if (!effects || effects.size === 0) return;
  const codes = [...ridingForecast.keys()].filter((c) => effects.has(String(c)));
  if (!codes.length) return;

  const shifted = ilrMatrix(codes.map((c) => partyCodes.map((p) => ridingForecast.get(c).shares[p])))
    .map((row, i) => {
      const eff = effects.get(String(codes[i]));
      return row.map((v, j) => v + Math.max(-0.35, Math.min(0.35, eff[j])));
    });
  const shares = mva.composition.ilrInv(shifted);
  codes.forEach((code, i) => {
    const entry = ridingForecast.get(code);
    partyCodes.forEach((p, j) => { entry.shares[p] = shares[i][j]; });
    entry.winner = partyCodes.reduce((best, p) => (entry.shares[p] > entry.shares[best] ? p : best), partyCodes[0]);
  });
}

/**
 * @param {Object} data every input JSON, keyed by short name
 * @param {Object} opts {asOf} -- defaults to today
 * @returns serializable projection object
 */
export function computeProjection(data, { asOf = new Date().toISOString().slice(0, 10) } = {}) {
  const {
    pollRows, baselineRows, leaders, ridingResults, features2017, features2026,
    systemicParams, ridingRegions, incumbents, leaderEffect, regionalPollRows,
  } = data;

  const { polls, partyCodes } = pivotPolls(pollRows);
  const model = fitTrend(polls, partyCodes);
  const daysToElection = Math.max(0, (new Date(ELECTION_DATE) - new Date(asOf)) / 86_400_000);

  const provinceBaseline2022 = provinceShareFromRows(baselineRows, partyCodes);
  const ridingBaselineMap = ridingBaselineFromRows(baselineRows, partyCodes);

  // Two baselines: the ACTUAL 2022 result for display and win/hold
  // semantics, and the projection baseline carrying the open-seat / leader /
  // regional adjustments. See the individual sections for rationale.
  const projectionBaselineMap = new Map([...ridingBaselineMap].map(([k, v]) => [k, [...v]]));

  const codeByRidingName = new Map(
    features2026.filter((f) => f.riding_name).map((f) => [f.riding_name, normalizeRidingCode(f.riding_code)])
  );
  const openSeatCodes = new Set(
    incumbents.filter((r) => r.elected_with_note).map((r) => codeByRidingName.get(r.riding_name)).filter(Boolean)
  );
  applyOpenSeatPenalty(projectionBaselineMap, openSeatCodes);

  // Leader effects: estimated 1970-2022, GP over year, extrapolated to 2026
  // (model/leader_effect.py -> qc_leader_effect.json).
  const arriveeFactor = Math.exp(leaderEffect.effects.arrivee.delta_2026);
  const continuationFactor = Math.exp(leaderEffect.effects.continuation.delta_2026);
  const departFactor = Math.exp(leaderEffect.effects.depart.delta_2026);
  const LEADERS_2022 = [
    { party: "CAQ", riding: "L'Assomption" },
    { party: "LIB", riding: "Saint-Henri-Sainte-Anne" },
    { party: "QS", riding: "Gouin" },
    { party: "PQ", riding: "Camille-Laurin" },
    { party: "PCQ", riding: "Chauveau" },
  ];
  const ridingOf2022Leader = new Map(LEADERS_2022.map((l) => [l.party, l.riding]));
  const baselineWinner = (code) => {
    const shares = ridingBaselineMap.get(code);
    return shares ? partyCodes[shares.indexOf(Math.max(...shares))] : null;
  };
  const nameKey = (n) => String(n ?? "").normalize("NFKD").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  const memberKeyByRiding = new Map(incumbents.map((r) => [r.riding_name, nameKey(r.member_name)]));

  for (const leader of leaders) {
    const party = leader.party_code;
    const partyIdx = partyCodes.indexOf(party);
    if (partyIdx < 0) continue;
    const prev = ridingOf2022Leader.get(party);
    const curr = leader.riding_name;

    if (curr === prev) {
      const code = codeByRidingName.get(curr);
      if (code) applyCompositionFactor(projectionBaselineMap, code, partyIdx, continuationFactor);
      continue;
    }
    if (curr) {
      const code = codeByRidingName.get(curr);
      const isOwnSeat = memberKeyByRiding.get(curr) === nameKey(leader.leader_name);
      if (code && !isOwnSeat) applyCompositionFactor(projectionBaselineMap, code, partyIdx, arriveeFactor);
    }
    if (prev) {
      const code = codeByRidingName.get(prev);
      const wonIt = baselineWinner(code) === party;
      const leaderGone = code && (openSeatCodes.has(code) || !wonIt);
      if (leaderGone) {
        const alreadyPenalized = openSeatCodes.has(code) && wonIt;
        applyCompositionFactor(
          projectionBaselineMap, code, partyIdx,
          alreadyPenalized ? departFactor * Math.exp(0.118) : departFactor
        );
      }
    }
  }

  // Regional joint GP: regional polls as observations of the same latent
  // object; per-riding adjustment = current regional deviation minus the
  // 2022 deviation already in the baseline. Validated on 2022 (MAE 3.06 vs
  // 3.61pp for uniform swing).
  let regionalInfo = null;
  const regionByCode = new Map(ridingRegions.map((r) => [String(r.riding_code), r.region_code]));
  try {
    const w = { MTL: 0, QC: 0, REG: 0 };
    const votesByRegionParty = {};
    for (const r of baselineRows) {
      const reg = regionByCode.get(normalizeRidingCode(r.riding_code));
      if (!reg) continue;
      w[reg] += r.votes;
      votesByRegionParty[reg] ??= Object.fromEntries(partyCodes.map((p) => [p, 0]));
      const party = partyCodes.includes(r.party_code) ? r.party_code : "AUTRES";
      votesByRegionParty[reg][party] += r.votes;
    }
    const wTot = REGIONS.reduce((s, r) => s + w[r], 0);
    for (const r of REGIONS) w[r] /= wTot;

    const natHyper = model.gps.map((g) => g.chosenHyperparams);
    const regionalModel = fitRegionalTrend(polls, regionalPollRows, partyCodes, natHyper, w);
    if (regionalModel.nRegionalPolls >= 3) {
      const devNow = regionalModel.predictDeviation(asOf);
      const regShares2022 = REGIONS.map((r) => {
        const v = votesByRegionParty[r];
        const tot = partyCodes.reduce((s, p) => s + v[p], 0);
        return partyCodes.map((p) => v[p] / tot);
      });
      const provShares2022 = partyCodes.map((p) => provinceBaseline2022[p]);
      const allIlr = ilrMatrix([...regShares2022, provShares2022]);
      const provIlr2022 = allIlr[allIlr.length - 1];

      for (const [code, shares] of projectionBaselineMap) {
        const reg = regionByCode.get(String(code));
        if (!reg) continue;
        const ri = REGIONS.indexOf(reg);
        const dev2022 = allIlr[ri].map((v, j) => v - provIlr2022[j]);
        const adj = devNow[reg].map((v, j) => v - dev2022[j]);
        const shifted = ilrMatrix([shares])[0].map((v, j) => v + adj[j]);
        projectionBaselineMap.set(code, mva.composition.ilrInv([shifted])[0]);
      }
      regionalInfo = { n: regionalModel.nRegionalPolls };
    }
  } catch (err) {
    console.error("[compute] regional trend failed, national swing only:", err.message);
  }

  const forecastPoint = Object.fromEntries(partyCodes.map((p) => [p, predictTrend(model, asOf, { seed: 42 })[p].mean]));
  const ridingForecast = uniformClrSwing(projectionBaselineMap, provinceBaseline2022, forecastPoint, partyCodes);

  // Riding-effects GP (Matérn), trained 2017-map transitions, applied to the
  // 2026 map. Degrades to national swing on failure.
  let effectsInfo = null, ridingEffects = null;
  try {
    const trained = trainRidingEffects(features2017, ridingResults, partyCodes);
    if (trained) {
      ridingEffects = predictRidingEffects(trained, features2026, ridingResults, partyCodes);
      effectsInfo = trained;
      applyEffectsToForecast(ridingForecast, ridingEffects, partyCodes);
    }
  } catch (err) {
    console.error("[compute] riding-effects model failed, national swing only:", err.message);
  }

  // Trend series for the chart.
  const dates = [];
  for (let d = new Date(polls[0].pollDate); d <= new Date(asOf); d.setDate(d.getDate() + 14)) {
    dates.push(d.toISOString().slice(0, 10));
  }
  // The 14-day stride rarely lands on asOf itself; without this the curve
  // stops up to 13 days short of the nowcast the projection actually uses.
  if (dates[dates.length - 1] !== asOf) dates.push(asOf);
  const trendSeries = predictTrendSeries(model, dates, { nSamples: 300, seed: 1 });

  // Simulation.
  const provinceDraws = sampleTrendDraws(model, asOf, 5000, 1);
  const residuals = effectsInfo?.modelResiduals
    ?? residualIlr(ridingResults, "2018-10-01", "2017", "2022-10-03", "2017", partyCodes).Y;
  const codeByName = new Map(features2026.filter((f) => f.riding_name).map((f) => [f.riding_name, String(f.riding_code)]));
  const residualRegions = (effectsInfo?.residualNames ?? []).map((name) => {
    const code = codeByName.get(name);
    return code ? regionByCode.get(code) ?? null : null;
  });

  const simulation = simulateSeatCounts(
    projectionBaselineMap, provinceBaseline2022, provinceDraws, residuals, partyCodes,
    {
      seed: 1,
      ridingEffects,
      systemic: {
        sigmaIndustry: systemicParams.sigma_industry,
        sigmaDaily2: systemicParams.sigma_daily2,
        daysToElection,
      },
      regionByRiding: regionByCode,
      residualRegions,
      noEffectScale: effectsInfo?.noEffectScale ?? 1,
    }
  );

  const pointCounts = Object.fromEntries(partyCodes.map((p) => [p, 0]));
  for (const entry of ridingForecast.values()) pointCounts[entry.winner]++;

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      asOf,
      electionDate: ELECTION_DATE,
      nPolls: polls.length,
      nRidings: ridingBaselineMap.size,
      effectsR2: effectsInfo ? effectsInfo.r2 : null,
      effectsCount: ridingEffects ? ridingEffects.size : 0,
      nRegionalPolls: regionalInfo ? regionalInfo.n : 0,
    },
    partyCodes,
    trendSeries,
    ridingForecast: Object.fromEntries(
      [...ridingForecast].map(([code, e]) => [code, { shares: e.shares, winner: e.winner }])
    ),
    ridingBaseline2022: Object.fromEntries(
      [...ridingBaselineMap].map(([code, arr]) => [code, Object.fromEntries(partyCodes.map((p, i) => [p, arr[i]]))])
    ),
    seatDistributions: seatDistributions(simulation.draws, partyCodes),
    pointCounts,
    // The most TYPICAL joint scenario: the draw minimising mean L1 distance
    // to all others. Unlike per-party medians it is jointly coherent and
    // sums to the house size; unlike pointCounts it centres the simulated
    // OUTCOMES rather than the model inputs.
    medoidCounts: medoidDraw(simulation.draws, partyCodes),
    // P(victory) per riding per party, tallied over the draws. Column sums
    // are exact expected seats, the one additive per-riding decomposition.
    ridingWinProbs: simulation.winProbs,
    totalSeats: simulation.totalSeats,
    scenarios: governmentScenarios(simulation.draws, simulation.totalSeats, partyCodes),
  };
}
