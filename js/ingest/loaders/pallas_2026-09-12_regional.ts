/**
 * One-off loader: REGIONAL rows only from Pallas Data's 2026-09-12 IVR poll
 * (n=1,085; decided-and-leaning 1,055). Source: data/raw/lus/
 * PallasData-Quebec-ElectionSemaine3-13septembre2026.pdf, p. 12.
 *
 * The NATIONAL row is left to Wikipedia (same key convention as the two
 * previous Pallas polls, both converged automatically). Regional shares
 * from the "décidés et enclins" table; Montréal RMR column used directly
 * (MTL region = the whole RMR). Unweighted decided bases: MTL 602,
 * QC 152, Reste 301.
 *
 * Run: deno run --allow-read --allow-write --allow-ffi --allow-env ingest/loaders/pallas_2026-09-12_regional.ts
 */

import { loadOneOff } from "../oneoff.ts";

await loadOneOff(
  "Pallas Data",
  "2026-09-12",
  "data/raw/lus/PallasData-Quebec-ElectionSemaine3-13septembre2026.pdf (Pallas Data, terrain 12 septembre 2026, p. 12)",
  {
    MTL: { n: 602, shares: { PQ: 23.8, CAQ: 20.2, LIB: 29.6, PCQ: 12.9, QS: 12.2, AUTRES: 1.3 } },
    QC: { n: 152, shares: { PQ: 20.1, CAQ: 23.9, LIB: 14.3, PCQ: 31.1, QS: 8.7, AUTRES: 1.7 } },
    REG: { n: 301, shares: { PQ: 34, CAQ: 26.6, LIB: 13, PCQ: 15.8, QS: 9.4, AUTRES: 1.2 } },
  },
);
