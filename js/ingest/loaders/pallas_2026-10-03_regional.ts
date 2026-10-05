/**
 * One-off loader: REGIONAL rows only from Pallas Data's final campaign poll
 * (IVR, field 2026-10-03, n=1,137; decided-and-leaning n=1,114, table
 * p. 12). Source: data/raw/lus/2026-10-03-pallas.pdf. National row left to
 * Wikipedia as usual (decided: PQ 29.0, PLQ 24.4, PCQ 20.4, CAQ 14.6,
 * QS 10.5, autre 1.1). Unweighted decided bases: MTL 591, QC 170, Reste 353.
 *
 * Run: deno run --allow-read --allow-write --allow-ffi --allow-env ingest/loaders/pallas_2026-10-03_regional.ts
 */

import { loadOneOff } from "../oneoff.ts";

await loadOneOff(
  "Pallas Data",
  "2026-10-03",
  "data/raw/lus/2026-10-03-pallas.pdf (Pallas Data, terrain 3 octobre 2026, p. 12)",
  {
    MTL: { n: 591, shares: { PQ: 28.4, LIB: 30.5, CAQ: 11.6, PCQ: 15.8, QS: 12.5, AUTRES: 1.2 } },
    QC: { n: 170, shares: { PQ: 23.7, LIB: 14.6, CAQ: 19.6, PCQ: 35.0, QS: 6.6, AUTRES: 0.4 } },
    REG: { n: 353, shares: { PQ: 32.0, LIB: 16.0, CAQ: 18.5, PCQ: 24.2, QS: 8.0, AUTRES: 1.3 } },
  },
);
