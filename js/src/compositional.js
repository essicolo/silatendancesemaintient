/**
 * Compositional-data helpers for aggregating polls (JS port of
 * src/polls/model/compositional.py). Uses @tangent.to/ds's own CLR/closure
 * implementation (mva/composition.js) rather than re-implementing it.
 */

import { mva } from "@tangent.to/ds";

const { closure, multiplicativeReplacement } = mva.composition;

/**
 * Pivot long-format poll rows (one row per poll x party, as exported by
 * export_json.py) into a wide array of poll records with a `.shares` map.
 * @param {Array<object>} rows - {poll_id, firm, poll_date, sample_size, firm_rating, party_code, pct_reported}
 * @returns {{polls: Array<object>, partyCodes: string[]}}
 */
export function pivotPolls(rows) {
  const partyCodes = [...new Set(rows.map((r) => r.party_code))].sort();
  const byPoll = new Map();
  for (const r of rows) {
    if (!byPoll.has(r.poll_id)) {
      byPoll.set(r.poll_id, {
        pollId: r.poll_id,
        firm: r.firm,
        pollDate: r.poll_date,
        sampleSize: r.sample_size,
        firmRating: r.firm_rating,
        // null, not 0: a party a poll never asked about is UNMEASURED, and
        // that is not the same claim as "measured at zero". Pre-2021 polls
        // did not break the PCQ out at all -- 106 of 266 in the series --
        // and initialising to 0 asserted a measurement none of them made.
        shares: Object.fromEntries(partyCodes.map((p) => [p, null])),
        reported: new Set(),
      });
    }
    const poll = byPoll.get(r.poll_id);
    poll.shares[r.party_code] = r.pct_reported / 100;
    poll.reported.add(r.party_code);
  }
  return { polls: [...byPoll.values()], partyCodes };
}

/** Simplex matrix (rows sum to 1), zero-replaced before closure -- CLR is
 * undefined at exactly 0. A poll with no reported "AUTRES" residual almost
 * certainly still had some non-zero minor-party/undecided share; (1/k)^2 --
 * matching nuee's default on the Python side, rather than tangent-ds's own
 * fixed 1e-6 -- imputes something on the same order as what other polls
 * actually report for it, instead of an effectively-zero placeholder.
 *
 * An UNMEASURED party (null) is handled by the same replacement, and that is
 * a deliberate reading rather than a shortcut: a pollster who did not break
 * the PCQ out was not ignoring its voters, it was counting them inside the
 * residual it did report. The poll is a coarser partition of the same whole,
 * so the party's support is amalgamated into "AUTRES" and the replacement
 * splits a plausible small share back out. It is an assumption, not a
 * measurement, and it only affects the pre-2021 stretch of the trend -- every
 * poll from 2021 on reports all six. */
export function toClosedComposition(polls, partyCodes) {
  const mat = polls.map((p) => partyCodes.map((c) => p.shares[c] ?? 0));
  const delta = (1 / partyCodes.length) ** 2;
  return closure(multiplicativeReplacement(mat, delta));
}

/** sqrt(n): the classical precision weight; recency is handled by the GP's
 * time dimension, not by an explicit decay. */
export function sampleSizeWeight(polls) {
  const sizes = polls.map((p) => p.sampleSize).filter((n) => n > 0);
  const median = sizes.sort((a, b) => a - b)[Math.floor(sizes.length / 2)] ?? 1000;
  return polls.map((p) => Math.sqrt(p.sampleSize > 0 ? p.sampleSize : median));
}
