/**
 * One-off loader: REGIONAL rows only from Pallas Data's 2026-08-29 IVR poll
 * (n=1,108). Source: data/raw/lus/
 * PallasData-Quebec-ElectionWeek1-PUBLIC-30aout2026.pdf.
 *
 * The NATIONAL row is deliberately NOT loaded: Wikipedia already carries this
 * poll (ingested by the watch on 2026-09-02, same firm/date/sample key), so
 * loading it here would be a no-op at best and a divergence at worst.
 *
 * Regional shares from the "décidés et enclins" table (p. 11), the base
 * matching the published national numbers. Pallas splits Île de Montréal
 * from Banlieue, but also gives the combined Montréal RMR column -- used
 * directly (MTL region = the whole RMR). Unweighted decided bases:
 * MTL 618, QC 160, Reste 296.
 *
 * Run: deno run --allow-read --allow-write --allow-ffi --allow-env ingest/loaders/pallas_2026-08-29_regional.ts
 */

import { loadOneOff } from "../oneoff.ts";

await loadOneOff(
  "Pallas Data",
  "2026-08-29",
  "data/raw/lus/PallasData-Quebec-ElectionWeek1-PUBLIC-30aout2026.pdf (Pallas Data, terrain 29 août 2026, p. 11)",
  {
    MTL: { n: 618, shares: { PQ: 29.3, CAQ: 24.2, LIB: 25.6, PCQ: 11.9, QS: 8.2, AUTRES: 0.8 } },
    QC: { n: 160, shares: { PQ: 25.8, CAQ: 24.4, LIB: 8.8, PCQ: 31.6, QS: 9.3, AUTRES: 0 } },
    REG: { n: 296, shares: { PQ: 28.1, CAQ: 24.3, LIB: 18.4, PCQ: 17.3, QS: 11.6, AUTRES: 0.2 } },
  },
);
