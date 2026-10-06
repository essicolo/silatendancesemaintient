/**
 * One-shot generator for the golden regression test: freezes the current
 * model inputs into js/test/fixtures/ and records the key outputs of
 * computeProjection on them (fixed asOf, fixed seeds) into
 * golden_expected.json. Re-run ONLY when a model change is intentional;
 * the diff of golden_expected.json then documents the change.
 *
 * Run: node js/test/make_golden.mjs   (from the repo root)
 */

import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { computeProjection } from "../src/computeProjection.js";
import { FIXTURE_FILES, GOLDEN_AS_OF, loadFixtures, extract } from "./golden_lib.mjs";

const dataDir = new URL("../data/", import.meta.url);
const fixDir = new URL("./fixtures/", import.meta.url);
mkdirSync(fixDir, { recursive: true });
for (const f of FIXTURE_FILES) {
  try { copyFileSync(new URL(f, dataDir), new URL(f, fixDir)); }
  catch { /* optional input absent */ }
}

const projection = computeProjection(loadFixtures(fixDir), { asOf: GOLDEN_AS_OF });
writeFileSync(new URL("./golden_expected.json", import.meta.url), JSON.stringify(extract(projection), null, 1));
console.log("fixtures figees et golden_expected.json ecrit (asOf " + GOLDEN_AS_OF + ")");
