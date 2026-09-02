/**
 * CLI wrapper: run the full modelling pipeline once and write
 * data/qc_projection.json. Invoked by hand or by `deno task compute`:
 *
 *   node js/tools/compute.mjs
 */

import { writeProjection } from "../src/writeProjection.js";

console.log(writeProjection());
