/**
 * Per-poll survey facts from the report PDFs: decided base and field
 * window, for National rows whose keys come from Wikipedia (the published
 * n stays the key; the decided base feeds the observation variance).
 * Values transcribed from the PDFs in data/raw/lus/ (see each loader's
 * header for the page references). Idempotent upsert; poll_id resolved by
 * (firm, poll_date, National) lookup so the entries survive key-n changes
 * on Wikipedia's side as long as firm and date match.
 *
 * Run: deno run --allow-read --allow-write --allow-ffi --allow-env ingest/poll_details.ts
 */

import { connect, all } from "./db.ts";

type Detail = {
  firm: string;
  date: string; // poll_date as stored (Wikipedia convention)
  n_decided?: number;
  field_start?: string;
  field_end?: string;
  source: string;
};

const DETAILS: Detail[] = [
  // NOTE date : Wikipédia date ces lignes à J-1 de la fin de terrain du
  // rapport (06 vs 07, 13 vs 14) -- mesure directe du flou de convention
  // relevé par la revue du 2026-10-06; la clé suit Wikipédia.
  { firm: "Léger", date: "2026-09-06", n_decided: 859, field_start: "2026-09-05", field_end: "2026-09-07", source: "Rapport-intentions-de-vote-7-septembre-2026-VF.pdf" },
  { firm: "Léger", date: "2026-09-13", n_decided: 842, field_start: "2026-09-12", field_end: "2026-09-14", source: "VMEDIA1_Rapport-intentions-de-vote-14-septembre-2026-Finale.pdf" },
  { firm: "Léger", date: "2026-09-21", n_decided: 903, field_start: "2026-09-18", field_end: "2026-09-21", source: "Rapport intentions de vote - 21 septembre 2026.pdf" },
  { firm: "Léger", date: "2026-09-27", n_decided: 873, field_start: "2026-09-25", field_end: "2026-09-27", source: "2026-09-26-leger.pdf" },
  { firm: "Léger", date: "2026-10-03", n_decided: 892, field_start: "2026-09-30", field_end: "2026-10-01", source: "Rapport intentions de vote - 3 octobre 2026.pdf" },
  { firm: "Synopsis Recherche", date: "2026-09-27", n_decided: 861, field_start: "2026-09-24", field_end: "2026-09-27", source: "2026-09-26-synopsis.pdf" },
  { firm: "Pallas Data", date: "2026-09-12", n_decided: 1055, field_end: "2026-09-12", source: "PallasData-Quebec-ElectionSemaine3-13septembre2026.pdf" },
  { firm: "Pallas Data", date: "2026-10-03", n_decided: 1114, field_end: "2026-10-03", source: "2026-10-03-pallas.pdf" },
  { firm: "Segma / Radio-Canada", date: "2026-09-17", n_decided: 4594, field_start: "2026-09-08", field_end: "2026-09-17", source: "segma_rapport_2026-09-17.pdf" },
];

const con = await connect();
let done = 0, missing = 0;
for (const d of DETAILS) {
  const rows = await all(
    con,
    `SELECT poll_id FROM polls
     WHERE jurisdiction_code = 'qc-provincial' AND region_code = 'National'
       AND firm = ? AND poll_date = ?::DATE`,
    [d.firm, d.date],
  );
  if (!rows.length) {
    console.log(`  ! introuvable en base : ${d.firm} ${d.date}`);
    missing++;
    continue;
  }
  const pid = String(rows[0].poll_id);
  await con.run("DELETE FROM poll_details WHERE poll_id = ?", [pid]);
  await con.run(
    "INSERT INTO poll_details VALUES (?, ?, ?::DATE, ?::DATE, ?)",
    [pid, d.n_decided ?? null, d.field_start ?? null, d.field_end ?? null, d.source],
  );
  done++;
}
console.log(`${done} details inseres, ${missing} sans ligne correspondante`);
con.closeSync();
