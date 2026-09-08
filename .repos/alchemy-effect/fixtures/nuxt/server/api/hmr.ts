// Edited by the dev-mode HMR spec (test/smoke.test.ts): the marker constant
// below is swapped in place, the spec polls until nitro's dev rebuild serves
// the new value, and the original source is restored in a finally.
const marker = "hmr-marker-v1";

export default defineEventHandler(() => ({ marker }));
