/**
 * Quick sensitivity check: the pre-2021 polls never report the PCQ (its
 * support sat inside the reported "AUTRES" residual; multiplicative
 * replacement imputes a small share back out). The TODO calls this an
 * assumption, not a measurement. This checks whether it moves TODAY'S
 * nowcast at all: refit the production trend on 2021+ polls only (every one
 * reports all six parties) and compare.
 *
 * Run: node js/tools/pcq_sensitivity.mjs   (from js/)
 */

import { readFileSync } from "node:fs";
import { mva } from "@tangent.to/ds";
import { pivotPolls } from "../src/compositional.js";
import { fitTrend, toX, predictTrend } from "../src/gpTrend.js";

const { ilrInv } = mva.composition;
const rows = JSON.parse(readFileSync(new URL("../data/qc_national_polls.json", import.meta.url), "utf-8"));
const { polls, partyCodes } = pivotPolls(rows);

const nowcast = (model, label) => {
  const now = new Date().toISOString().slice(0, 10);
  const p = predictTrend(model, now, { nSamples: 1000, seed: 7 });
  console.log(
    `${label.padEnd(24)} ` +
    partyCodes.map((c) => `${c} ${(p[c].mean * 100).toFixed(2)} [${(p[c].p05 * 100).toFixed(1)}-${(p[c].p95 * 100).toFixed(1)}]`).join("  ")
  );
};

const full = fitTrend(polls, partyCodes);
nowcast(full, "tous (271, prod.)");

const recent = polls.filter((p) => p.pollDate >= "2021-01-01");
const model2021 = fitTrend(recent, partyCodes);
nowcast(model2021, `2021+ seulement (${recent.length})`);

// hyperparams chosen on recent-only data, for the record
console.log("\nhyperparamètres 2021+ :");
model2021.gps.forEach((gp, c) => {
  const h = gp.chosenHyperparams;
  console.log(`  coord ${c}: lengthScale=${h.lengthScale}, noiseScale=${h.noiseScale}, rho=${h.rho}, dilation=${h.dilation}`);
});
console.log("\n(prod. : coord0 1000/0.5/0.7/16, coord1 330/0.1/1/4, coord2 1500/0.05/1/8, coord3 680/0.05/1/16, coord4 330/0.25/1/8)");