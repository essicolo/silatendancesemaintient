/**
 * One-off loader: Léger/Le Journal/TVA poll, report dated 2026-09-14,
 * n=1,013 (842 decided). Source: data/raw/lus/
 * VMEDIA1_Rapport-intentions-de-vote-14-septembre-2026-Finale.pdf (p. 7).
 *
 * National decided: PQ 29, PLQ 23, CAQ 21, PCQ 17, QS 10, autres 1. The
 * Liberals move into second ahead of the CAQ; best PCQ score of the cycle.
 * Regional crosstab maps onto project regions (MTL RMR 332 / QC RMR 262 /
 * Reste 248). The National row converges to Wikipedia's version on the
 * next watch reload (their date convention is the last field day).
 *
 * Run: deno run --allow-read --allow-write --allow-ffi --allow-env ingest/loaders/leger_2026-09-14.ts
 */

import { loadOneOff } from "../oneoff.ts";

await loadOneOff(
  "Léger",
  "2026-09-14",
  "data/raw/lus/VMEDIA1_Rapport-intentions-de-vote-14-septembre-2026-Finale.pdf (Léger/Le Journal/TVA, rapport du 14 septembre 2026)",
  {
    National: { n: 1013, shares: { PQ: 29, LIB: 23, CAQ: 21, PCQ: 17, QS: 10, AUTRES: 1 } },
    MTL: { n: 332, shares: { PQ: 24, LIB: 32, CAQ: 21, PCQ: 12, QS: 10, AUTRES: 1 } },
    QC: { n: 262, shares: { PQ: 31, LIB: 11, CAQ: 21, PCQ: 29, QS: 8, AUTRES: 0 } },
    REG: { n: 248, shares: { PQ: 34, LIB: 14, CAQ: 22, PCQ: 20, QS: 9, AUTRES: 1 } },
  },
);
