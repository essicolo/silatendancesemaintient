/**
 * One-off loader: REGIONAL rows of the Segma/Radio-Canada poll (field
 * 2026-09-08 to 17). The full report PDF surfaced after the national-only
 * ingestion: data/raw/lus/segma_rapport_2026-09-17.pdf, main crosstab p. 5
 * (intentions excluding undecideds, n=4,594), whose regional split is
 * EXACTLY this project's regions: Montréal RMR n=1,501, Québec RMR n=622,
 * Autres régions n=2,471 -- the heaviest regional observations of the
 * cycle. "Tout autre parti < 1 %" entered at the published bound, per the
 * censored-residual convention. Firm spelled as Wikipedia's National row
 * ("Segma / Radio-Canada") so the pair stays associated.
 *
 * Run: deno run --allow-read --allow-write --allow-ffi --allow-env ingest/loaders/segma_2026-09-17_regional.ts
 */

import { loadOneOff } from "../oneoff.ts";

await loadOneOff(
  "Segma / Radio-Canada",
  "2026-09-17",
  "data/raw/lus/segma_rapport_2026-09-17.pdf (Segma/Radio-Canada/Coops, terrain 8-17 septembre 2026, p. 5)",
  {
    MTL: { n: 1501, shares: { PQ: 26, CAQ: 19, LIB: 26, PCQ: 13, QS: 16, AUTRES: 1 } },
    QC: { n: 622, shares: { PQ: 27, CAQ: 21, LIB: 13, PCQ: 27, QS: 12, AUTRES: 1 } },
    REG: { n: 2471, shares: { PQ: 33, CAQ: 26, LIB: 12, PCQ: 21, QS: 8, AUTRES: 1 } },
  },
);
