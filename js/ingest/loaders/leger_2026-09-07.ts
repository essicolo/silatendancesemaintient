/**
 * One-off loader: Léger/Le Journal/TVA poll, report dated 2026-09-07,
 * n=1,008 (859 decided). Source: data/raw/lus/
 * Rapport-intentions-de-vote-7-septembre-2026-VF.pdf (projet 10016937, p. 7).
 *
 * National decided: PQ 29, CAQ 23, PLQ 22, PCQ 15, QS 10, autres 1 -- the
 * CAQ recovery pauses (24 -> 23 in Léger's own series). Regional crosstab
 * maps one-to-one onto project regions (MTL RMR / QC RMR / Reste du Québec),
 * decided-voter bases 338 + 265 + 256 = 859.
 *
 * Run: deno run --allow-read --allow-write --allow-ffi --allow-env ingest/loaders/leger_2026-09-07.ts
 */

import { loadOneOff } from "../oneoff.ts";

await loadOneOff(
  "Léger",
  "2026-09-07",
  "data/raw/lus/Rapport-intentions-de-vote-7-septembre-2026-VF.pdf (Léger/Le Journal/TVA, rapport du 7 septembre 2026)",
  {
    National: { n: 1008, shares: { PQ: 29, CAQ: 23, LIB: 22, PCQ: 15, QS: 10, AUTRES: 1 } },
    MTL: { n: 338, shares: { PQ: 24, CAQ: 19, LIB: 30, PCQ: 13, QS: 13, AUTRES: 1 } },
    QC: { n: 265, shares: { PQ: 27, CAQ: 25, LIB: 10, PCQ: 26, QS: 10, AUTRES: 1 } },
    REG: { n: 256, shares: { PQ: 35, CAQ: 27, LIB: 15, PCQ: 15, QS: 7, AUTRES: 1 } },
  },
);
