/**
 * Run the full modelling pipeline once and write data/qc_projection.json for
 * the dashboard to display. Shared by the CLI (tools/compute.mjs) and the
 * poll watch (ingest/watch.ts), which imports it directly instead of
 * spawning a subprocess.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { computeProjection } from "./computeProjection.js";

export function writeProjection(dataDir = new URL("../data/", import.meta.url)) {
  const load = (f) => JSON.parse(readFileSync(new URL(f, dataDir), "utf-8"));
  const loadOptional = (f) => {
    try { return load(f); } catch { return []; } // by-elections: absent = none
  };

  const t0 = Date.now();
  const projection = computeProjection({
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
  });

  writeFileSync(new URL("qc_projection.json", dataDir), JSON.stringify(projection), "utf-8");
  const m = projection.meta;
  return (
    `qc_projection.json ecrit en ${((Date.now() - t0) / 1000).toFixed(1)}s : ` +
    `${m.nPolls} sondages, ${m.nRidings} circonscriptions, R2 effets=${m.effectsR2?.toFixed(2)}, ` +
    `${m.nRegionalPolls} sondages regionaux, sieges point=${JSON.stringify(projection.pointCounts)}`
  );
}
