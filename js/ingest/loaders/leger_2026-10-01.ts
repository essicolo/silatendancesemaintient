/**
 * One-off loader: Léger/Le Journal/TVA poll, field 2026-09-30 to 10-01,
 * n=1,000 (892 decided), published 2026-10-03 -- the final poll of the
 * campaign. Source: data/raw/lus/Rapport intentions de vote - 3 octobre
 * 2026.pdf (p. 7).
 *
 * National decided: PQ 29, PLQ 25, PCQ 20, CAQ 14, QS 11, autres 1.
 * Regional (decided bases): MTL RMR 373 / QC RMR 256 / Reste 263; the
 * QC RMR "autre parti" is published at 0 and entered at 0.5 (rounding
 * bound, censored-residual convention).
 *
 * Run: deno run --allow-read --allow-write --allow-ffi --allow-env ingest/loaders/leger_2026-10-01.ts
 */

import { loadOneOff } from "../oneoff.ts";

await loadOneOff(
  "Léger",
  "2026-10-01",
  "data/raw/lus/Rapport intentions de vote - 3 octobre 2026.pdf (Léger/Le Journal/TVA, terrain 30 septembre - 1er octobre 2026)",
  {
    National: { n: 1000, shares: { PQ: 29, LIB: 25, PCQ: 20, CAQ: 14, QS: 11, AUTRES: 1 } },
    MTL: { n: 373, shares: { PQ: 26, LIB: 34, PCQ: 14, CAQ: 10, QS: 14, AUTRES: 2 } },
    QC: { n: 256, shares: { PQ: 28, LIB: 18, PCQ: 37, CAQ: 8, QS: 8, AUTRES: 0.5 } },
    REG: { n: 263, shares: { PQ: 33, LIB: 16, PCQ: 22, CAQ: 19, QS: 8, AUTRES: 1 } },
  },
);
