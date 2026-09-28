/**
 * One-off loader: REGIONAL rows only from Pallas Data's 2026-09-26 IVR poll
 * (decided-and-leaning n=1,164, table p. 12). Source: data/raw/lus/
 * 2026-09-26-pallas.pdf. National row left to Wikipedia as usual.
 * Unweighted decided bases: MTL 581, QC 225, Reste 358.
 *
 * Run: deno run --allow-read --allow-write --allow-ffi --allow-env ingest/loaders/pallas_2026-09-26_regional.ts
 */

import { loadOneOff } from "../oneoff.ts";

await loadOneOff(
  "Pallas Data",
  "2026-09-26",
  "data/raw/lus/2026-09-26-pallas.pdf (Pallas Data, terrain 26 septembre 2026, p. 12)",
  {
    MTL: { n: 581, shares: { PQ: 29.1, LIB: 31.3, CAQ: 17.2, PCQ: 10.9, QS: 8.3, AUTRES: 3.3 } },
    QC: { n: 225, shares: { PQ: 23.7, LIB: 7.8, CAQ: 23.8, PCQ: 32.9, QS: 10.8, AUTRES: 1.1 } },
    REG: { n: 358, shares: { PQ: 32.5, LIB: 11.6, CAQ: 19.1, PCQ: 24.7, QS: 11.7, AUTRES: 0.4 } },
  },
);
