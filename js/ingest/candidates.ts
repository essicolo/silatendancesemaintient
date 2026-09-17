/**
 * 2026 candidates per riding per party, from the English Wikipedia page
 * "Candidates in the 2026 Quebec general election" (20 regional wikitables;
 * the French wiki has no equivalent page). Display-only data: written
 * straight to js/data/qc_candidates.json {riding_code: {party: name}},
 * no DuckDB round trip.
 *
 * Each table carries two header rows (region layout | party columns, whose
 * ORDER VARIES between tables) and data rows of the form
 * [district, (colour, name) x parties, incumbent...]; only the five main
 * parties are kept. Names carry footnote markers and confirmation stars,
 * stripped here. Riding names are matched to 2026 codes after accent/
 * punctuation normalisation; unmatched rows are reported, never guessed.
 *
 * Candidacies keep changing until the nomination deadline; re-run on
 * demand:  deno task candidates
 */

import { writeFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { USER_AGENT } from "./wiki_polls.ts";

const PAGE = "https://en.wikipedia.org/wiki/Candidates_in_the_2026_Quebec_general_election";
const PARTY_COLUMNS: Record<string, string> = {
  CAQ: "CAQ", Liberal: "LIB", QS: "QS", PQ: "PQ", PCQ: "PCQ", Conservative: "PCQ",
};

const norm = (x: string) =>
  x.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

const nameByCode: Record<string, string> = JSON.parse(
  await Deno.readTextFile(new URL("../../data/riding_names_2026.json", import.meta.url)),
);
const codeByNorm = new Map(Object.entries(nameByCode).map(([code, name]) => [norm(name), code]));

const cleanName = (t: string) =>
  t.replace(/\[.*?\]/g, "").replace(/[*†‡]/g, "").replace(/\s+/g, " ").trim();

const resp = await fetch(PAGE, { headers: { "User-Agent": USER_AGENT } });
const { document } = parseHTML(await resp.text());

const out: Record<string, Record<string, string>> = {};
const unmatched: string[] = [];

for (const table of document.querySelectorAll("table.wikitable")) {
  const trs = [...table.querySelectorAll("tr")];
  if (trs.length < 3) continue;
  const partyHeader = [...trs[1].querySelectorAll("th")].map((th) => (th.textContent ?? "").trim());
  if (!partyHeader.includes("CAQ")) continue;

  for (const tr of trs.slice(2)) {
    const cells = [...tr.children].filter((c) => c.tagName === "TD");
    if (cells.length < 1 + 2 * partyHeader.length) continue;
    const district = cleanName(cells[0].textContent ?? "");
    const code = codeByNorm.get(norm(district));
    if (!code) { if (district) unmatched.push(district); continue; }
    const rec: Record<string, string> = out[code] ?? {};
    partyHeader.forEach((col, k) => {
      const party = PARTY_COLUMNS[col];
      if (!party) return;
      const name = cleanName(cells[2 + 2 * k]?.textContent ?? "");
      if (name) rec[party] = name;
    });
    out[code] = rec;
  }
}

writeFileSync(
  new URL("../data/qc_candidates.json", import.meta.url),
  JSON.stringify(out, null, 1),
  "utf-8",
);
const filled = Object.values(out).reduce((s, r) => s + Object.keys(r).length, 0);
console.log(`qc_candidates.json : ${Object.keys(out).length} circonscriptions, ${filled} candidatures`);
if (unmatched.length) console.log("  non appariees :", [...new Set(unmatched)].join(" | "));
