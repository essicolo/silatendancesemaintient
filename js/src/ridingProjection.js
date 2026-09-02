/**
 * Riding-level projection: national swing plus each riding's own predicted
 * departure from it.
 *
 * The model is trained on the 2017 map, where two consecutive transitions
 * exist (2014->2018 predicting 2018->2022), and applied to the 2026 map,
 * where the predictors are that map's demographics plus its own most recent
 * residual (2018->2022, reprojected onto the 2026 boundaries via polling
 * divisions). Training and application therefore never share an election,
 * and the riding identities differ -- only the learned relationship carries
 * across.
 *
 * A riding present on the target map but missing a predictor (e.g. a newly
 * created 2026 riding with no reprojected 2018 result) simply gets no
 * departure applied: it falls back to the national swing alone rather than
 * being dropped from the projection.
 */

import { buildFeatureMatrix, residualIlr, PARTIES } from "./ridingEffects.js";
import { fitMultivariate, multivariateR2 } from "./ridingModel.js";

/** Join feature rows to residual rows via riding name, returning aligned matrices. */
function align(featureRows, residual) {
  const { X, ridings: codes } = buildFeatureMatrix(featureRows);
  const codeByName = new Map(featureRows.filter((f) => f.riding_name).map((f) => [f.riding_name, String(f.riding_code)]));
  const rowByCode = new Map(codes.map((c, i) => [c, i]));

  const Xa = [], Ya = [], names = [];
  residual.ridings.forEach((name, i) => {
    const code = codeByName.get(String(name)) ?? String(name);
    const row = rowByCode.get(code);
    if (row === undefined) return;
    Xa.push(X[row]);
    Ya.push(residual.Y[i]);
    names.push(String(name));
  });
  return { X: Xa, Y: Ya, names };
}

/**
 * Fit on the 2017 map. Returns null (rather than throwing) if there isn't
 * enough overlap to train on -- the caller then projects with national
 * swing alone, which is a degraded but valid projection.
 */
export function trainRidingEffects(features2017, ridingResults, partyCodes = PARTIES) {
  const prev = residualIlr(ridingResults, "2014-04-07", "2011", "2018-10-01", "2017", partyCodes);
  const curr = residualIlr(ridingResults, "2018-10-01", "2017", "2022-10-03", "2017", partyCodes);

  const prevByName = new Map(prev.ridings.map((r, i) => [String(r), prev.Y[i]]));
  const target = align(features2017, curr);

  const X = [], Y = [], names = [];
  target.names.forEach((name, i) => {
    const p = prevByName.get(name);
    if (!p) return;
    X.push([...target.X[i], ...p]); // demographics + own previous departure
    Y.push(target.Y[i]);
    names.push(name);
  });
  if (X.length < 40) return null;

  const r2 = multivariateR2(X, Y, { repeats: 15, seed: 0 });
  const model = fitMultivariate(X, Y);

  // Out-of-sample residuals, for the simulation to sample as noise.
  //
  // This must be the model's PREDICTION ERROR, not the raw departure from
  // the provincial swing. The raw departure is precisely what the model now
  // predicts, so feeding it back in as noise double-counts: the simulation
  // would apply the effect once deterministically and again as a random
  // draw of the same magnitude. That inflated the spread badly enough to
  // put QS at 88 seats in some draws and to pull the simulation medians far
  // away from the point projection they should agree with.
  //
  // Held-out rather than in-sample so the spread reflects genuine
  // predictive error and isn't shrunk by the model having seen these rows.
  const heldOut = heldOutResiduals(X, Y, names);

  // How much wider the RAW departure is than the model's prediction error.
  // Ridings the model can't predict (no reprojected previous result) should
  // carry raw-departure noise, not the smaller model-error noise -- otherwise
  // the least-known seats get the tightest intervals.
  const rawSd = rmsOf(Y);
  const residSd = rmsOf(heldOut.residuals);
  const noEffectScale = residSd > 0 ? rawSd / residSd : 1;

  return {
    model, r2, nTrain: X.length,
    modelResiduals: heldOut.residuals, residualNames: heldOut.names, noEffectScale,
  };
}

function rmsOf(rows) {
  let sq = 0, n = 0;
  for (const r of rows) for (const v of r) { sq += v * v; n++; }
  return n ? Math.sqrt(sq / n) : 0;
}

/**
 * Residuals from repeated held-out fits, pooled, tagged with their riding
 * name (so downstream can decompose them regionally).
 *
 * Hyperparameters are re-selected inside every training half rather than
 * inherited from the full-data fit: reusing them lets every "held-out" row
 * influence the model it is then scored under -- a mild leak, but exactly
 * the kind that makes "out-of-sample" residuals a little too small.
 */
function heldOutResiduals(X, Y, ridingNames, { repeats = 6, seed = 7 } = {}) {
  let state = seed;
  const rand = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };

  const residuals = [], names = [];
  for (let rep = 0; rep < repeats; rep++) {
    const idx = X.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    const half = Math.floor(idx.length / 2);
    const tr = idx.slice(0, half), te = idx.slice(half);
    const Xtr = tr.map((i) => X[i]), Ytr = tr.map((i) => Y[i]);
    const m = fitMultivariate(Xtr, Ytr);
    const preds = m.predict(te.map((i) => X[i]));
    te.forEach((i, k) => {
      residuals.push(Y[i].map((v, j) => v - preds[k][j]));
      names.push(ridingNames[i]);
    });
  }
  return { residuals, names };
}

/**
 * Predicted ILR departure per riding on the 2026 map.
 * @returns {Map<string, number[]>} riding_code -> ILR shift
 */
export function predictRidingEffects(trained, features2026, ridingResults, partyCodes = PARTIES) {
  if (!trained) return new Map();

  const recent = residualIlr(ridingResults, "2018-10-01", "2026", "2022-10-03", "2026", partyCodes);
  const recentByCode = new Map(recent.ridings.map((r, i) => [String(r), recent.Y[i]]));

  const { X, ridings } = buildFeatureMatrix(features2026);
  const rows = [], codes = [];
  ridings.forEach((code, i) => {
    const prevResidual = recentByCode.get(String(code));
    if (!prevResidual) return; // no recent departure on this map -> national swing only
    rows.push([...X[i], ...prevResidual]);
    codes.push(String(code));
  });
  if (!rows.length) return new Map();

  const shifts = trained.model.predict(rows);
  return new Map(codes.map((c, i) => [c, shifts[i]]));
}
