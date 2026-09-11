/**
 * By-election (partielle) signal for the riding projection.
 *
 * Since 2022, five by-elections were held -- four won by the PQ in former
 * CAQ seats. The production model saw them only as OPEN SEATS (the 2022
 * winner's incumbency bonus removed); the result itself, a direct recent
 * measurement of the riding's departure from the provincial swing, went
 * unused. This module measures that departure and blends it into the
 * riding-effects, shrinking toward the demographic-GP prediction:
 *
 *   dev = ilr(bye_shares) - ilr(rid2022_shares_openseat_adjusted)
 *         - [trend_ilr(t_bye) - ilr(provincial 2022 RESULT)]
 *         - regionalAdjustment(riding's region)
 *
 * Piece by piece:
 *   - the 2022 riding shares are penalised by the production incumbency
 *     factor FIRST, so the measured departure is net of the
 *     incumbent-leaving effect the projection baseline already encodes
 *     (otherwise it would be counted twice);
 *   - the provincial anchor is the 2022 RESULT, not the poll trend at 2022,
 *     so dev is a result-to-result local swing net of provincial movement;
 *   - the CURRENT regional adjustment is SUBTRACTED so the regional-GP
 *     component (which the pipeline applies to every riding of the region)
 *     is not double-counted. Under the regional GP's fitted length scales
 *     (400-1000 days) the regional departure is nearly constant over the
 *     span, so subtracting its current value is the right de-overlap.
 *
 * The blend on the GP-predicted effect: (1-lambda)*e_gp + lambda*dev. The
 * GP effect and dev estimate the SAME quantity -- the riding's CHANGE in
 * local departure since 2022 -- one from demographics, one from a direct
 * local measurement.
 *
 * lambda = 0.5, and the honest limits that justify shrinking at all:
 *   1. by-elections have low turnout and protest dynamics; their swings
 *      run systematically larger than general-election swings;
 *   2. the by-election ran on 2017-map boundaries, applied here to the
 *      same-NAME 2026 riding (Arthabaska -> Arthabaska-L'Érable was
 *      redrawn; the rename table below covers the known cases);
 *   3. part of the measured swing is a strong local candidate who may not
 *      run again (part of it is the new incumbent's personal vote, which
 *      DOES persist);
 *   4. there is no historical by-election series in the database to
 *      VALIDATE the gain out-of-sample -- the sensitivity table lives in
 *      tools/byelection_test.mjs; the choice of lambda is a documented
 *      prior, not a fitted parameter.
 *
 * Data: js/data/qc_byelections.json (ingest/export_json.ts), rows of
 * {election_date, riding_code (2017-map NAME), party_code, votes}.
 */

import { mva } from "@tangent.to/ds";
import { toX } from "./gpTrend.js";
import { INCUMBENCY_FACTOR } from "./swing.js";

const { ilr, closure, multiplicativeReplacement } = mva.composition;

/** Blend weight on the measured by-election departure (see header). */
export const BYELECTION_LAMBDA = 0.5;

/** 2017-map name -> 2026-map name for by-election ridings redrawn+renamed. */
const RENAME_2017_TO_2026 = { arthabaska: "Arthabaska-L'Érable" };

export const nameKey = (n) =>
  String(n ?? "").normalize("NFKD").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();

function ilrRow(parts) {
  const delta = (1 / parts.length) ** 2;
  return ilr(closure(multiplicativeReplacement([parts], delta)))[0];
}

/** Party shares of one riding at one election, matched by name (the
 * ridingResults and by-election exports both key rows by riding NAME). */
function sharesByName(rows, date, name, partyCodes, boundary = null) {
  const votes = Object.fromEntries(partyCodes.map((p) => [p, 0]));
  let tot = 0;
  for (const r of rows) {
    if (r.election_date !== date) continue;
    if (boundary !== null && String(r.boundary_year) !== String(boundary)) continue;
    if (nameKey(r.riding_code) !== nameKey(name)) continue;
    const party = partyCodes.includes(r.party_code) ? r.party_code : "AUTRES";
    votes[party] += r.votes;
    tot += r.votes;
  }
  if (!tot) return null;
  return partyCodes.map((p) => votes[p] / tot);
}

/** Provincial shares at one election on one map. */
function provinceShares(rows, date, boundary, partyCodes) {
  const votes = Object.fromEntries(partyCodes.map((p) => [p, 0]));
  let tot = 0;
  for (const r of rows) {
    if (r.election_date !== date || String(r.boundary_year) !== String(boundary)) continue;
    const party = partyCodes.includes(r.party_code) ? r.party_code : "AUTRES";
    votes[party] += r.votes;
    tot += r.votes;
  }
  return partyCodes.map((p) => votes[p] / tot);
}

/**
 * Compute each by-election's ILR departure, keyed by the 2026-map riding
 * code it applies to. Returns an empty map when anything is missing --
 * the projection then simply keeps the demographic-GP effect, which is a
 * degraded but valid state, not an error.
 *
 * @param {Object} args { byRows, ridingResults, features2017, features2026,
 *   model (fitTrend result), partyCodes, regionAdj (Map region -> ILR vector
 *   of the CURRENT regional adjustment, or null), regionByCode (Map riding
 *   code -> region, or null) }
 * @returns {{byCode: Map<string, {dev: number[], name: string, date: string, regionPart: number[] | null}>}}
 */
export function byelectionDeviations({
  byRows, ridingResults, features2017, features2026, model, partyCodes,
  regionAdj = null, regionByCode = null,
}) {
  const byCode = new Map();
  if (!byRows?.length) return { byCode };

  const code2026ByName = new Map(
    features2026.filter((f) => f.riding_name).map((f) => [nameKey(f.riding_name), String(Math.round(parseFloat(f.riding_code)))])
  );
  const code2017ByName = new Map(
    features2017.filter((f) => f.riding_name).map((f) => [nameKey(f.riding_name), String(Math.round(parseFloat(f.riding_code)))])
  );
  // The by-election rows carry the 2017-map name: find the same-named 2026
  // riding, or its renamed equivalent.
  const resolve2026 = (name2017) => {
    const direct = code2026ByName.get(nameKey(name2017));
    if (direct) return { code: direct, name: name2017 };
    const renamed = RENAME_2017_TO_2026[nameKey(name2017)];
    const code = renamed ? code2026ByName.get(nameKey(renamed)) : undefined;
    return code ? { code, name: renamed } : { code: null, name: name2017 };
  };

  const prov2022Ilr = ilrRow(provinceShares(ridingResults, "2022-10-03", "2017", partyCodes));
  const trendIlrAt = (date) => {
    const x = toX(model.t0, [date]);
    return model.gps.map((gp) => gp.predict(x)[0]);
  };

  // group by-election rows by (date, riding)
  const byes = new Map();
  for (const r of byRows) {
    const key = `${r.election_date}|${r.riding_code}`;
    if (!byes.has(key)) byes.set(key, { date: String(r.election_date), name: String(r.riding_code) });
  }

  for (const { date, name: name2017 } of byes.values()) {
    const { code: code26, name: name2026 } = resolve2026(name2017);
    if (!code26) continue;

    const byeShares = sharesByName(byRows, date, name2017, partyCodes);
    const rid2022 = sharesByName(ridingResults, "2022-10-03", name2017, partyCodes, "2017");
    if (!byeShares || !rid2022) continue;

    // open-seat-adjusted 2022 baseline: remove the departing incumbent's
    // personal vote the way the projection baseline does.
    let winner = 0;
    for (let j = 1; j < rid2022.length; j++) if (rid2022[j] > rid2022[winner]) winner = j;
    const adjusted = rid2022.map((v, j) => (j === winner ? v / INCUMBENCY_FACTOR : v));
    const adjustedTot = adjusted.reduce((a, b) => a + b, 0);

    const trendBye = trendIlrAt(date);
    const dev = ilrRow(byeShares).map(
      (v, c) =>
        v - ilrRow(adjusted.map((x) => x / adjustedTot))[c] - (trendBye[c] - prov2022Ilr[c])
    );

    byCode.set(String(code26), { dev, name: name2026, date, regionPart: null });
  }

  // De-overlap the regional component: the pipeline's regional block shifts
  // every riding of a region by (regional deviation now) minus (regional
  // deviation in 2022). The measured by-election departure contains that
  // same regional movement -- subtract it so it is not applied twice.
  if (regionAdj) {
    for (const [code, entry] of byCode) {
      const region = regionByCode ? regionByCode.get(String(code)) : null;
      entry.regionPart = region ? regionAdj.get(region) ?? null : null;
    }
  }
  return { byCode };
}

/**
 * Blend the measured by-election departures into the riding-effects map.
 * A riding whose seat had no by-election keeps its GP effect untouched.
 * @returns {Map<string, number[]>}
 */
export function blendByelectionEffects(effects, byCode, lambda = BYELECTION_LAMBDA) {
  if (!byCode?.size) return effects;
  const out = new Map(effects);
  for (const [code, { dev, regionPart }] of byCode) {
    const effective = regionPart ? dev.map((v, c) => v - regionPart[c]) : dev;
    const e = out.get(String(code)) ?? null;
    out.set(String(code), effective.map((v, c) => (1 - lambda) * (e ? e[c] : 0) + lambda * v));
  }
  return out;
}