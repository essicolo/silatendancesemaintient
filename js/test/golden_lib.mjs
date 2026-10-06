/** Shared pieces of the golden regression test. */

import { readFileSync } from "node:fs";

export const GOLDEN_AS_OF = "2026-10-05";

export const FIXTURE_FILES = [
  "qc_national_polls.json", "qc_2022_baseline_2026map.json", "qc_leaders.json",
  "qc_riding_results.json", "qc_riding_features_2017.json", "qc_riding_features_2026.json",
  "qc_systemic.json", "qc_riding_regions.json", "qc_incumbents.json",
  "qc_leader_effect.json", "qc_regional_polls.json", "qc_byelections.json", "qc_turnout.json",
];

export function loadFixtures(dir) {
  const load = (f) => JSON.parse(readFileSync(new URL(f, dir), "utf-8"));
  const loadOptional = (f) => { try { return load(f); } catch { return []; } };
  return {
    pollRows: load("qc_national_polls.json"),
    baselineRows: load("qc_2022_baseline_2026map.json"),
    leaders: load("qc_leaders.json"),
    ridingResults: load("qc_riding_results.json"),
    features2017: load("qc_riding_features_2017.json"),
    features2026: load("qc_riding_features_2026.json"),
    systemicParams: load("qc_systemic.json"),
    ridingRegions: load("qc_riding_regions.json"),
    incumbents: load("qc_incumbents.json"),
    leaderEffect: load("qc_leader_effect.json"),
    regionalPollRows: load("qc_regional_polls.json"),
    byelectionRows: loadOptional("qc_byelections.json"),
    turnout: null, // retired (w=0 verdict), mirrors writeProjection
  };
}

/** The compared outputs: small, deterministic (fixed seeds + asOf), and
 * covering every pipeline stage (trend, turnout, effects, simulation). */
export function extract(projection) {
  const probes = ["117", "234", "371", "648", "811"];
  const last = projection.trendSeries[projection.trendSeries.length - 1];
  return {
    asOf: projection.meta.asOf,
    nPolls: projection.meta.nPolls,
    trendHyper: projection.meta.trendHyper,
    turnoutFactor: projection.meta.turnoutFactor,
    nowcastMean: Object.fromEntries(projection.partyCodes.map((p) => [p, +(last[p].mean).toFixed(6)])),
    pointCounts: projection.pointCounts,
    medoidCounts: projection.medoidCounts,
    winProbProbes: Object.fromEntries(probes.map((c) => [
      c,
      projection.ridingWinProbs[c]
        ? Object.fromEntries(Object.entries(projection.ridingWinProbs[c]).map(([p, v]) => [p, +v.toFixed(4)]))
        : null,
    ])),
    gallagherP50: +projection.disproportion.gallagher.p50.toFixed(4),
  };
}
