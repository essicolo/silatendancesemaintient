/**
 * One-off loader: Synopsis/La Presse poll, field 2026-09-24 to 27, n=1,000
 * (861 after redistribution). Synopsis published a REPORT this time:
 * data/raw/lus/2026-09-26-synopsis.pdf (after-redistribution table p. 7).
 *
 * National: PQ 30, PLQ 22, CAQ 17, PCQ 17, QS 13; "un autre parti 0 %"
 * entered at 0.5 (rounding bound of a published 0, per the
 * censored-residual convention -- a literal 0 would trigger the ~2.8 %
 * zero replacement). Regional: île (n=179) and RMR-hors-île (n=184)
 * combined into MTL with their own decided bases -- real weights this
 * time, no borrowed structure; QC RMR 188, Ailleurs 310.
 *
 * Run: deno run --allow-read --allow-write --allow-ffi --allow-env ingest/loaders/synopsis_2026-09-27.ts
 */

import { loadOneOff } from "../oneoff.ts";

// Île: PQ 18, LIB 38, CAQ 13, PCQ 9, QS 22 -- RMR hors île: PQ 32, LIB 21,
// CAQ 22, PCQ 14, QS 10. Weights 179 / 184 (published decided bases).
const ILE = { PQ: 18, LIB: 38, CAQ: 13, PCQ: 9, QS: 22, AUTRES: 0.5 };
const RMR = { PQ: 32, LIB: 21, CAQ: 22, PCQ: 14, QS: 10, AUTRES: 0.5 };
const W_ILE = 179, W_RMR = 184;
const MTL = Object.fromEntries(
  Object.keys(ILE).map((p) => [p, +((ILE[p] * W_ILE + RMR[p] * W_RMR) / (W_ILE + W_RMR)).toFixed(1)]),
);

await loadOneOff(
  "Synopsis Recherche",
  "2026-09-27",
  "data/raw/lus/2026-09-26-synopsis.pdf (Synopsis/La Presse, terrain 24-27 septembre 2026, p. 7)",
  {
    National: { n: 1000, shares: { PQ: 30, LIB: 22, CAQ: 17, PCQ: 17, QS: 13, AUTRES: 0.5 } },
    MTL: { n: W_ILE + W_RMR, shares: MTL },
    QC: { n: 188, shares: { PQ: 30, LIB: 13, CAQ: 20, PCQ: 31, QS: 5, AUTRES: 1 } },
    REG: { n: 310, shares: { PQ: 36, LIB: 17, CAQ: 15, PCQ: 20, QS: 11, AUTRES: 1 } },
  },
);
