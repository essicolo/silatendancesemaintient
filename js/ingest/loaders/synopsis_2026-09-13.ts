/**
 * One-off loader: Synopsis/La Presse poll, field 2026-09-10 to 13, n=1,000
 * (879 after redistribution of undecideds). Synopsis publishes no report
 * PDF; source is the charts of the La Presse article (print captured in
 * data/raw/lus/synopsis.pdf, chart images extracted alongside in
 * _syn_img/), "Sondage Synopsis-La Presse : l'effet de la guerre
 * commerciale s'estompe", 2026-09-14.
 *
 * National (après répartition): PQ 28, CAQ 24, PLQ 22, PCQ 14, QS 11.
 * Regional chart splits Île de Montréal from RMR-hors-île; combined into
 * MTL with the decided-voter weights of the previous Synopsis poll
 * (213/204 of 867, the only weights the house has published), scaled to
 * 879: île ~216, hors-île ~207 -- a documented approximation. QC RMR and
 * Ailleurs map directly; their n are scaled the same way (~157, ~299).
 *
 * Run: deno run --allow-read --allow-write --allow-ffi --allow-env ingest/loaders/synopsis_2026-09-13.ts
 */

import { loadOneOff } from "../oneoff.ts";

// Île: PQ 18, CAQ 15, LIB 29, PCQ 16, QS 21 -- RMR hors île: PQ 29, CAQ 27,
// LIB 26, PCQ 8, QS 7. Weights 216 / 207.
const ILE = { PQ: 18, CAQ: 15, LIB: 29, PCQ: 16, QS: 21, AUTRES: 1 };
const RMR = { PQ: 29, CAQ: 27, LIB: 26, PCQ: 8, QS: 7, AUTRES: 3 };
const W_ILE = 216, W_RMR = 207;
const MTL = Object.fromEntries(
  Object.keys(ILE).map((p) => [p, +((ILE[p] * W_ILE + RMR[p] * W_RMR) / (W_ILE + W_RMR)).toFixed(1)]),
);

await loadOneOff(
  "Synopsis Recherche",
  "2026-09-13",
  "data/raw/lus/synopsis.pdf (Synopsis/La Presse, terrain 10-13 septembre 2026, graphiques de l'article)",
  {
    National: { n: 1000, shares: { PQ: 28, CAQ: 24, LIB: 22, PCQ: 14, QS: 11, AUTRES: 1 } },
    MTL: { n: W_ILE + W_RMR, shares: MTL },
    QC: { n: 157, shares: { PQ: 27, CAQ: 23, LIB: 17, PCQ: 23, QS: 11, AUTRES: 0 } },
    REG: { n: 299, shares: { PQ: 34, CAQ: 27, LIB: 17, PCQ: 14, QS: 8, AUTRES: 0 } },
  },
);
