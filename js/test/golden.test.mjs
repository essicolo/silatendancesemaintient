/**
 * Golden regression test: computeProjection on FROZEN inputs (fixtures/)
 * must reproduce golden_expected.json. Its job is to distinguish "the
 * environment changed" (library bump, runtime bump, accidental behavior
 * change) from "the data changed" after a long sleep -- the first
 * command of the wake-up runbook. Seat counts from the simulation are
 * compared exactly (fixed seeds); continuous outputs at tight tolerance.
 *
 * Run: npm test   (from js/; ~1 min, the full fitTrend grid runs once)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computeProjection } from "../src/computeProjection.js";
import { GOLDEN_AS_OF, loadFixtures, extract } from "./golden_lib.mjs";

test("golden: computeProjection sur fixtures figees", { timeout: 300_000 }, () => {
  const expected = JSON.parse(readFileSync(new URL("./golden_expected.json", import.meta.url), "utf-8"));
  const got = extract(computeProjection(loadFixtures(new URL("./fixtures/", import.meta.url)), { asOf: GOLDEN_AS_OF }));

  assert.equal(got.nPolls, expected.nPolls);
  assert.deepEqual(got.pointCounts, expected.pointCounts);
  assert.deepEqual(got.medoidCounts, expected.medoidCounts);
  assert.deepEqual(got.trendHyper, expected.trendHyper);
  for (const [p, v] of Object.entries(expected.nowcastMean)) {
    assert.ok(Math.abs(got.nowcastMean[p] - v) < 1e-4, `nowcast ${p}: ${got.nowcastMean[p]} vs ${v}`);
  }
  assert.equal(got.turnoutFactor == null, expected.turnoutFactor == null, "turnoutFactor nullite");
  for (const [p, v] of Object.entries(expected.turnoutFactor ?? {})) {
    assert.ok(Math.abs(got.turnoutFactor[p] - v) < 1e-6, `turnout ${p}`);
  }
  for (const [code, probs] of Object.entries(expected.winProbProbes)) {
    if (!probs) continue;
    for (const [p, v] of Object.entries(probs)) {
      assert.ok(Math.abs(got.winProbProbes[code][p] - v) < 0.02, `winProb ${code}/${p}: ${got.winProbProbes[code][p]} vs ${v}`);
    }
  }
  assert.ok(Math.abs(got.gallagherP50 - expected.gallagherP50) < 0.5, `gallagher ${got.gallagherP50} vs ${expected.gallagherP50}`);
});
