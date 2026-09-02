/**
 * Poll ingestion from Wikipedia's maintained polling tables — Deno/TypeScript
 * port of the retired Python parser (tag `python-archive`), byte-for-byte on poll_id.
 *
 * The Python original carries the full rationale (provenance, coverage,
 * the one-day date-convention offset that makes this a replacement rather
 * than a merge). Two invariants matter most here and are enforced by the
 * parity test (ingest/parity.ts):
 *
 *   - poll_id = sha1("jurisdiction|region|firm|date|sample")[:16], so ids
 *     stay stable across the Python -> Deno switch and re-ingest stays
 *     idempotent.
 *   - Subgroup tables (by language, region, age...) share their column
 *     layout with the province-wide tables; only the SECTION HEADING above
 *     distinguishes them. Tables are walked in document order with their
 *     h2/h3/h4 chain, and any table under a breakdown heading is rejected.
 *     Reading those as province-wide once put the Liberals at 80% in 2015.
 */

import { createHash } from "node:crypto";
import { parseHTML } from "linkedom";

export const USER_AGENT =
  "polls-research-bot/0.1 (contact: yysrk9lh@duck.com; Quebec election forecasting project)";
const API = "https://fr.wikipedia.org/w/api.php";

export const POLL_PAGES: Record<string, string> = {
  "2026": "Liste de sondages sur les élections générales québécoises de 2026",
  "2022": "Liste de sondages sur les élections générales québécoises de 2022",
  "2018": "Liste de sondages sur les élections générales québécoises de 2018",
};

// Wikipedia's column headers -> our party codes. PVQ (Green) exists only in
// the 2018 table and folds into AUTRES: a party present in one election and
// structurally missing in the next cannot be its own part of the composition.
const PARTY_COLUMNS: Record<string, string> = {
  CAQ: "CAQ",
  PLQ: "LIB",
  QS: "QS",
  PQ: "PQ",
  PCQ: "PCQ",
  CQ: "PCQ",
  PVQ: "AUTRES",
  Autres: "AUTRES",
};

// Wikipedia abbreviates; the database already holds these spellings from the
// previous source. Normalising keeps poll_id stable across the switch.
const FIRM_NORMALIZE: Record<string, string> = {
  Mainstreet: "Mainstreet Research",
  Pallas: "Pallas Data",
  Liaison: "Liaison Strategies",
  Innovative: "Innovative Research",
  Synopsis: "Synopsis Recherche",
  "Synopsis / La Presse": "Synopsis Recherche",
  Segma: "Segma Recherche",
  "Research Co": "Research Co.",
  Forum: "Forum Research",
};

const MONTHS: Record<string, number> = {
  janvier: 1, "février": 2, fevrier: 2, mars: 3, avril: 4, mai: 5,
  juin: 6, juillet: 7, "août": 8, aout: 8, septembre: 9,
  octobre: 10, novembre: 11, "décembre": 12, decembre: 12,
};

export interface PageSnapshot {
  title: string;
  revid: number;
  html: string;
}

export interface PollRow {
  poll_id: string;
  jurisdiction_code: string;
  region_code: string;
  firm: string;
  poll_date: string; // ISO, kept as string end to end (no Date tz pitfalls)
  sample_size: number | null;
  is_rolling: boolean;
  firm_rating: null;
  general_election: null;
  source_url: string;
}

export interface ShareRow {
  poll_id: string;
  party_code: string;
  pct_reported: number;
}

export async function latestRevision(title: string): Promise<number> {
  const params = new URLSearchParams({
    action: "query", prop: "revisions", titles: title, rvprop: "ids", format: "json",
  });
  const resp = await fetch(`${API}?${params}`, { headers: { "User-Agent": USER_AGENT } });
  if (!resp.ok) throw new Error(`API ${resp.status} pour ${title}`);
  const pages = (await resp.json()).query.pages;
  const page = Object.values(pages)[0] as { revisions?: { revid: number }[] };
  if (!page.revisions) throw new Error(`page introuvable sur fr.wikipedia : ${title}`);
  return page.revisions[0].revid;
}

export async function fetchPage(title: string): Promise<PageSnapshot> {
  // Revision id BEFORE the HTML: an edit landing between the two requests
  // then leaves a stale stored revid, so the next watch run re-examines the
  // page instead of silently skipping the edit's polls.
  const revid = await latestRevision(title);
  const url = `https://fr.wikipedia.org/wiki/${title.replaceAll(" ", "_")}`;
  const resp = await fetch(url, { headers: { "User-Agent": USER_AGENT }, redirect: "follow" });
  if (!resp.ok) throw new Error(`fetch ${resp.status} pour ${url}`);
  // fetch() decodes strictly as UTF-8 here, which is exactly what we want —
  // httpx's charset sniffing once mis-decoded "août" and killed date parsing.
  return { title, revid, html: await resp.text() };
}

function parseDate(text: string): string | null {
  const cleaned = text.replace(/\[.*?\]/g, "").trim().toLowerCase().replaceAll(" ", " ");
  const m = cleaned.match(/(\d{1,2})\s+([a-zéûôà]+)\s+(\d{4})/);
  if (!m) return null;
  const month = MONTHS[m[2]];
  if (!month) return null;
  const dd = m[1].padStart(2, "0");
  return `${m[3]}-${String(month).padStart(2, "0")}-${dd}`;
}

/** Cells carry footnote markers, thin/no-break spaces, decimal commas and
 * en-dashes for "not asked". */
function parseNumber(text: string): number | null {
  const cleaned = String(text)
    .replace(/\[.*?\]/g, "")
    .replace(/[\s   ]/g, "")
    .replaceAll(",", ".")
    .replaceAll("%", "")
    .replaceAll("±", "");
  const m = cleaned.match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function normalizeFirm(text: string): string {
  let t = text.replace(/\[.*?\]/g, "").trim();
  t = t.replace(/\s*\/\s*La Presse$/, "");
  return FIRM_NORMALIZE[t] ?? t;
}

export function pollId(
  jurisdiction: string, region: string, firm: string, pollDate: string, sample: string | null,
): string {
  const key = `${jurisdiction}|${region}|${firm}|${pollDate}|${sample ?? ""}`;
  return createHash("sha1").update(key, "utf-8").digest("hex").slice(0, 16);
}

// The subgroup is never in the table; it is in the section heading above it.
const BREAKDOWN_PATTERNS = [
  "par langue", "par region", "par age", "par sexe", "par groupe",
  "francophone", "chez les", "ile de montreal", "region metropolitaine",
  "capitale-nationale", "reste du quebec",
];

const stripAccents = (text: string): string =>
  text.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\x00-\x7f]/g, "");

const isBreakdown = (headings: string[]): boolean => {
  const joined = stripAccents(headings.join(" / ")).toLowerCase();
  return BREAKDOWN_PATTERNS.some((p) => joined.includes(p));
};

const cleanHeading = (text: string): string =>
  text.replace("[modifier | modifier le code]", "").replace(/\s+/g, " ").trim();

/** (table, heading chain) in document order — querySelectorAll returns
 * document order, so this mirrors the Python xpath walk exactly. */
function* tablesWithHeadings(document: Document): Generator<[Element, string[]]> {
  const chain = new Map<number, string>();
  for (const node of document.querySelectorAll("h2,h3,h4,table")) {
    const tag = node.tagName.toLowerCase();
    if (tag !== "table") {
      const level = Number(tag[1]);
      chain.set(level, cleanHeading(node.textContent ?? ""));
      for (const k of [...chain.keys()]) if (k > level) chain.delete(k);
    } else {
      yield [node, [...chain.keys()].sort((a, b) => a - b).map((k) => chain.get(k)!)];
    }
  }
}

const cellLink = (cell: Element): string | null => {
  for (const a of cell.querySelectorAll("a")) {
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("http") && !href.includes("wikipedia.org") && !href.includes("wikimedia.org")) {
      return href;
    }
  }
  return null;
};

/** Rows that are not polls — the tables interleave narrative event rows like
 * "14 janvier 2026 : Annonce de la démission de François Legault" — are
 * dropped by requiring both a parseable date and >= 2 numeric party cells. */
export function parsePolls(
  snapshot: PageSnapshot, jurisdiction = "qc-provincial",
): { polls: PollRow[]; shares: ShareRow[] } {
  const { document } = parseHTML(snapshot.html);
  const pollRows: PollRow[] = [];
  const shareRows: ShareRow[] = [];
  const seen = new Set<string>();
  const skipped: [string, number][] = [];

  for (const [table, headings] of tablesWithHeadings(document)) {
    const firstTr = table.querySelector("tr");
    if (!firstTr) continue;
    const headers = [...firstTr.querySelectorAll("th")].map((th) => (th.textContent ?? "").trim());
    if (!headers.includes("Sondeur") || !headers.includes("CAQ")) continue;
    if (isBreakdown(headings)) {
      skipped.push([headings.at(-1) ?? "?", table.querySelectorAll("tr").length - 1]);
      continue;
    }
    const idx = new Map(headers.map((name, i) => [name, i]));
    const partyIdx = headers
      .map((h, i) => [h, i] as const)
      .filter(([h]) => h in PARTY_COLUMNS);

    for (const tr of table.querySelectorAll("tr")) {
      const cells = [...tr.children].filter((c) => c.tagName === "TD");
      if (cells.length < headers.length - 2) continue;

      const pollDate = parseDate(cells[0].textContent ?? "");
      if (pollDate === null) continue;

      const shares = new Map<string, number>();
      for (const [col, i] of partyIdx) {
        if (i >= cells.length) continue;
        const value = parseNumber(cells[i].textContent ?? "");
        if (value === null) continue;
        const code = PARTY_COLUMNS[col];
        shares.set(code, (shares.get(code) ?? 0) + value);
      }
      if (shares.size < 2) continue;

      const firmI = idx.get("Sondeur")!;
      if (firmI >= cells.length) continue;
      const firm = normalizeFirm(cells[firmI].textContent ?? "");
      if (!firm) continue;

      let sample: number | null = null;
      const sampleI = idx.get("Échantillon");
      if (sampleI !== undefined && sampleI < cells.length) {
        const raw = parseNumber(cells[sampleI].textContent ?? "");
        sample = raw !== null && raw > 0 ? Math.trunc(raw) : null;
      }

      let sourceUrl: string | null = null;
      const sourceI = idx.get("Source");
      if (sourceI !== undefined && sourceI < cells.length) sourceUrl = cellLink(cells[sourceI]);

      const pid = pollId(jurisdiction, "National", firm, pollDate, sample !== null ? String(sample) : null);
      if (seen.has(pid)) continue;
      seen.add(pid);

      pollRows.push({
        poll_id: pid,
        jurisdiction_code: jurisdiction,
        region_code: "National",
        firm,
        poll_date: pollDate,
        sample_size: sample,
        is_rolling: false,
        firm_rating: null,
        general_election: null,
        source_url: sourceUrl ?? `https://fr.wikipedia.org/wiki/${snapshot.title.replaceAll(" ", "_")}`,
      });
      for (const [code, pct] of shares) {
        shareRows.push({ poll_id: pid, party_code: code, pct_reported: pct });
      }
    }
  }

  if (skipped.length) {
    // Announce what was dropped: a silent filter looks identical to a source
    // that never had those tables.
    const detail = skipped.map(([name, n]) => `${name} (${n})`).join(", ");
    console.log(`    sous-groupes ignores : ${detail}`);
  }

  return { polls: pollRows, shares: shareRows };
}

/** All configured cycles, concatenated and de-duplicated on poll_id, plus the
 * revision id seen for each page so a watcher records what it processed. */
export async function fetchAll(
  cycles?: string[],
): Promise<{ polls: PollRow[]; shares: ShareRow[]; revisions: Record<string, number> }> {
  const polls: PollRow[] = [];
  const shares: ShareRow[] = [];
  const revisions: Record<string, number> = {};
  const seen = new Set<string>();
  for (const cycle of cycles ?? Object.keys(POLL_PAGES)) {
    const snapshot = await fetchPage(POLL_PAGES[cycle]);
    const parsed = parsePolls(snapshot);
    revisions[cycle] = snapshot.revid;
    for (const p of parsed.polls) {
      if (seen.has(p.poll_id)) continue;
      seen.add(p.poll_id);
      polls.push(p);
    }
    for (const s of parsed.shares) if (seen.has(s.poll_id)) shareIfNew(shares, s);
  }
  return { polls, shares, revisions };
}

const shareIfNew = (acc: ShareRow[], s: ShareRow): void => {
  // parsePolls already de-duplicates within a page; across pages a duplicate
  // poll_id keeps its first shares, matching polars' unique(keep="first").
  if (!acc.some((r) => r.poll_id === s.poll_id && r.party_code === s.party_code)) acc.push(s);
};
