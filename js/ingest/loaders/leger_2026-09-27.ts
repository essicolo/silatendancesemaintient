/**
 * One-off loader: Léger/Le Journal/TVA poll, field 2026-09-25 to 27,
 * n=1,001 (873 decided). Source: data/raw/lus/2026-09-26-leger.pdf (p. 7).
 *
 * National decided: PQ 30, PLQ 26, PCQ 18, CAQ 16, QS 9, autres 1 -- the
 * CAQ drops four points to FOURTH place in the final week. Regional:
 * MTL RMR 350 / QC RMR 273 / Reste 250.
 *
 * Run: deno run --allow-read --allow-write --allow-ffi --allow-env ingest/loaders/leger_2026-09-27.ts
 */

import { loadOneOff } from "../oneoff.ts";

await loadOneOff(
  "Léger",
  "2026-09-27",
  "data/raw/lus/2026-09-26-leger.pdf (Léger/Le Journal/TVA, terrain 25-27 septembre 2026)",
  {
    National: { n: 1001, shares: { PQ: 30, LIB: 26, PCQ: 18, CAQ: 16, QS: 9, AUTRES: 1 } },
    MTL: { n: 350, shares: { PQ: 27, LIB: 36, PCQ: 9, CAQ: 17, QS: 10, AUTRES: 1 } },
    QC: { n: 273, shares: { PQ: 29, LIB: 15, PCQ: 31, CAQ: 15, QS: 10, AUTRES: 1 } },
    REG: { n: 250, shares: { PQ: 34, LIB: 17, PCQ: 25, CAQ: 15, QS: 8, AUTRES: 1 } },
  },
);
