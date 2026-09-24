/**
 * One-off loader: Léger/Le Journal/TVA poll, field 2026-09-18 to 21,
 * n=1,001 (903 decided). Source: data/raw/lus/
 * "Rapport intentions de vote - 21 septembre 2026.pdf" (p. 7).
 *
 * National decided: PQ 29, PLQ 23, CAQ 20, PCQ 17, QS 10, autres 1.
 * Regional: MTL RMR 350 / QC RMR 281 / Reste 272 -- PCQ at 34 % in the
 * Québec RMR, its strongest regional reading of the cycle. The National
 * row converges to Wikipedia's version on the next watch reload.
 *
 * Run: deno run --allow-read --allow-write --allow-ffi --allow-env ingest/loaders/leger_2026-09-21.ts
 */

import { loadOneOff } from "../oneoff.ts";

await loadOneOff(
  "Léger",
  "2026-09-21",
  "data/raw/lus/Rapport intentions de vote - 21 septembre 2026.pdf (Léger/Le Journal/TVA, terrain 18-21 septembre 2026)",
  {
    National: { n: 1001, shares: { PQ: 29, LIB: 23, CAQ: 20, PCQ: 17, QS: 10, AUTRES: 1 } },
    MTL: { n: 350, shares: { PQ: 25, LIB: 33, CAQ: 19, PCQ: 11, QS: 11, AUTRES: 2 } },
    QC: { n: 281, shares: { PQ: 23, LIB: 15, CAQ: 18, PCQ: 34, QS: 9, AUTRES: 0 } },
    REG: { n: 272, shares: { PQ: 36, LIB: 14, CAQ: 22, PCQ: 20, QS: 8, AUTRES: 0 } },
  },
);
