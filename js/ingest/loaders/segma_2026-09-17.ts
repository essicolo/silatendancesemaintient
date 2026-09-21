/**
 * One-off loader: Segma Recherche / Radio-Canada / Les Coops de
 * l'information, field 2026-09-08 to 17, n=5,572 (phone + web) -- the
 * largest sample of the cycle (GP weight ~2.4x a typical n=1,000 poll
 * under the 1/sqrt(n) noise). No report PDF is published; source is the
 * Radio-Canada long-format article.
 *
 * National (decided): PQ 29, CAQ 22, PLQ 19, PCQ 18, QS 12.
 *
 * NATIONAL ONLY, deliberately: the companion articles break down by
 * administrative region (île n=731, couronnes 517/513, Outaouais 502,
 * BSL 501...), but PCQ and QS are unpublished for the couronnes (charts
 * rendered as images) and the zones do not map onto MTL/QC/REG without
 * speculative imputation. The National row converges to Wikipedia's
 * version when their table carries it (same firm normalisation "Segma
 * Recherche", last-field-day date).
 *
 * Run: deno run --allow-read --allow-write --allow-ffi --allow-env ingest/loaders/segma_2026-09-17.ts
 */

import { loadOneOff } from "../oneoff.ts";

await loadOneOff(
  "Segma Recherche",
  "2026-09-17",
  "https://ici.radio-canada.ca/info/long-format/2285606/sondage-radio-canada-parti-quebec-conservateur-liberaux (Segma/Radio-Canada/Coops de l'information, terrain 8-17 septembre 2026)",
  {
    National: { n: 5572, shares: { PQ: 29, CAQ: 22, LIB: 19, PCQ: 18, QS: 12, AUTRES: 1.0 } }, // le graphique publie « < 1 % » : on entre la borne, pas un point arbitraire; 0 declencherait le remplacement de zero (~2,8 %)
  },
);
