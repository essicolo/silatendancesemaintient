/**
 * One-off loader: REGIONAL rows only from Pallas Data's 2026-09-19 IVR poll
 * (n=1,089). Source: data/raw/lus/
 * PallasData-Quebec-Semaine4-19septembre2026.pdf, "décidés et enclins"
 * table p. 12. National row came via Wikipedia (the usual convergence).
 * Montréal RMR column used directly; unweighted bases MTL 608, QC 116,
 * Reste 365.
 *
 * Run: deno run --allow-read --allow-write --allow-ffi --allow-env ingest/loaders/pallas_2026-09-19_regional.ts
 */

import { loadOneOff } from "../oneoff.ts";

await loadOneOff(
  "Pallas Data",
  "2026-09-19",
  "data/raw/lus/PallasData-Quebec-Semaine4-19septembre2026.pdf (Pallas Data, terrain 19 septembre 2026, p. 12)",
  {
    MTL: { n: 608, shares: { PQ: 25.6, CAQ: 21.7, LIB: 27.9, PCQ: 10.6, QS: 13.4, AUTRES: 0.8 } },
    QC: { n: 116, shares: { PQ: 28.5, CAQ: 24.5, LIB: 9.9, PCQ: 30.9, QS: 5.5, AUTRES: 0.6 } },
    REG: { n: 365, shares: { PQ: 31.4, CAQ: 22.3, LIB: 15.9, PCQ: 21.1, QS: 9, AUTRES: 0.2 } },
  },
);
