/**
 * Mandate-cycle analysis ("usure du pouvoir"), fully from the database
 * (Atlas riding results 1871-2012 + DGEQ 2014-2026).
 *
 * For every provincial general election: seats per party = ridings where
 * the party has the most votes (native boundary = smallest boundary_year
 * for that date; 'Electeur_inscrits' artifact rows excluded; by-elections
 * excluded by requiring >= 60 ridings). Governments are chains of
 * consecutive wins by the same party; for each election we record the
 * incumbent, the number of consecutive mandates it holds, whether it was
 * re-elected, and its vote-share change.
 *
 * Output: re-election rate and mean vote swing by mandate rank, for the
 * full series and for the post-1960 era (the claim "rarely 2, never 3"
 * is modern: the Liberals held 9 consecutive mandates 1897-1936).
 *
 * Run (from js/): deno run --allow-read --allow-write --allow-ffi --allow-env tools/mandate_cycle.ts
 */

import { connect, all } from "../ingest/db.ts";

const PARTY: Record<string, string> = {
  Parti_liberal: "LIB", LIB: "LIB",
  Parti_quebecois: "PQ", PQ: "PQ",
  Union_nationale: "UN",
  Parti_conservateur: "CONS",
  Coalition_avenir_quebec: "CAQ", CAQ: "CAQ",
  Action_democratique_du_quebec: "ADQ",
};
const norm = (p: string) => PARTY[p] ?? (p.startsWith("Autres") ? "AUTRES" : p);

const con = await connect();
const rows = await all(con, `
  SELECT election_date::VARCHAR AS d, boundary_year, riding_code, party_code, votes
  FROM election_results
  WHERE jurisdiction_code = 'qc-provincial' AND riding_code IS NOT NULL
    AND party_code <> 'Electeur_inscrits'`);
con.closeSync();

// native boundary per election = smallest boundary_year
const byElection = new Map<string, Map<string, { riding: string; party: string; votes: number }[]>>();
for (const r of rows) {
  const d = String(r.d).slice(0, 10);
  if (!byElection.has(d)) byElection.set(d, new Map());
  const byB = byElection.get(d)!;
  const b = String(r.boundary_year);
  if (!byB.has(b)) byB.set(b, []);
  byB.get(b)!.push({ riding: String(r.riding_code), party: norm(String(r.party_code)), votes: Number(r.votes) });
}

type ElectionSummary = { date: string; seats: Map<string, number>; share: Map<string, number>; winner: string };
const elections: ElectionSummary[] = [];
for (const [d, byB] of [...byElection].sort()) {
  const b = [...byB.keys()].sort()[0];
  const list = byB.get(b)!;
  const byRiding = new Map<string, { party: string; votes: number }[]>();
  const voteTot = new Map<string, number>();
  let grand = 0;
  for (const r of list) {
    if (!byRiding.has(r.riding)) byRiding.set(r.riding, []);
    byRiding.get(r.riding)!.push(r);
    voteTot.set(r.party, (voteTot.get(r.party) ?? 0) + r.votes);
    grand += r.votes;
  }
  if (byRiding.size < 60) continue; // by-elections
  const seats = new Map<string, number>();
  for (const cands of byRiding.values()) {
    const w = cands.reduce((a, c) => (c.votes > a.votes ? c : a));
    seats.set(w.party, (seats.get(w.party) ?? 0) + 1);
  }
  const share = new Map([...voteTot].map(([p, v]) => [p, (v / grand) * 100]));
  const winner = [...seats].sort((a, b2) => b2[1] - a[1])[0][0];
  elections.push({ date: d, seats, share, winner });
}

console.log(`${elections.length} élections générales provinciales (${elections[0].date} -> ${elections.at(-1)!.date})\n`);

// chains and incumbent outcomes
type Cas = { date: string; incumbent: string; mandates: number; reelected: boolean; swing: number };
const cases: Cas[] = [];
let holder = elections[0].winner, mandates = 1;
for (let i = 1; i < elections.length; i++) {
  const e = elections[i], prev = elections[i - 1];
  const reelected = e.winner === holder;
  cases.push({
    date: e.date, incumbent: holder, mandates,
    reelected,
    swing: (e.share.get(holder) ?? 0) - (prev.share.get(holder) ?? 0),
  });
  if (reelected) mandates++;
  else { holder = e.winner; mandates = 1; }
}

console.log("élection | sortant | mandats | réélu | swing du sortant (pp)");
for (const c of cases) {
  console.log(`  ${c.date.slice(0, 4)}     ${c.incumbent.padEnd(5)} ${String(c.mandates).padStart(4)}      ${c.reelected ? "OUI" : "non"}   ${c.swing >= 0 ? "+" : ""}${c.swing.toFixed(1)}`);
}

const tally = (list: Cas[], label: string) => {
  console.log(`\n${label} :`);
  for (const band of [[1, 1], [2, 2], [3, 99]] as [number, number][]) {
    const sel = list.filter((c) => c.mandates >= band[0] && c.mandates <= band[1]);
    if (!sel.length) continue;
    const w = sel.filter((c) => c.reelected).length;
    const sw = sel.reduce((s, c) => s + c.swing, 0) / sel.length;
    const lbl = band[1] === 99 ? `${band[0]}e mandat et +` : `cherche son ${band[0] + 1}e mandat`;
    console.log(`  ${lbl.padEnd(24)} : réélu ${w}/${sel.length}  swing moyen ${sw >= 0 ? "+" : ""}${sw.toFixed(1)} pp`);
  }
};
tally(cases, "série complète");
tally(cases.filter((c) => c.date >= "1960"), "ère moderne (1960+)");
