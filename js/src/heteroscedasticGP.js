/**
 * @tangent.to/ds's GaussianProcessRegressor only takes a single scalar
 * `alpha` (uniform observation noise) -- see _refit() in
 * ml/estimators/GaussianProcessRegressor.js, which adds `this.alpha` to
 * every diagonal entry of the training kernel matrix. This project needs
 * per-poll noise (a poll far in the past, or from a small/low-rated house,
 * should count for less), so this subclass overrides just `_refit()` to add
 * a per-observation noise vector to the diagonal instead. `predict()` and
 * `sample()` are untouched and work unmodified: they only depend on the
 * `_alphaVector`/`_L` that `_refit()` produces.
 *
 * Deliberately NOT monkey-patching or forking the library -- this is a thin
 * extension point exactly where the class was already designed to be
 * subclassed (kernel + alpha are both constructor-configurable, `_refit` is
 * the one method that hardcodes the scalar assumption).
 */

import { ml, core } from "@tangent.to/ds";

const { cholesky, choleskySolve } = core.linalg;

export class HeteroscedasticGP extends ml.GaussianProcessRegressor {
  /** @param {Array<Array<number>>} X @param {Array<number>} y @param {Array<number>} noiseVector - per-observation noise variance, same length as y */
  fit(X, y, noiseVector) {
    this._noiseVector = noiseVector;
    return super.fit(X, y);
  }

  _refit() {
    const K = this.kernel.call(this._XTrain);
    const noise = this._noiseVector;
    for (let i = 0; i < K.rows; i++) {
      K.set(i, i, K.get(i, i) + (noise ? noise[i] : this.alpha));
    }
    try {
      this._L = cholesky(K);
    } catch (error) {
      throw new Error(`Failed to fit GP: ${error.message}. Try increasing noise.`);
    }
    this._alphaVector = choleskySolve(this._L, this._yTrain);
    return this;
  }
}
