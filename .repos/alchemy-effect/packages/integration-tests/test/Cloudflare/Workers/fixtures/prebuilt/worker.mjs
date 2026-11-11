// SENTINEL: alchemy-prebuilt-worker 7c2e
//
// This file is a hand-written, prebuilt ESM Worker deployed with
// `bundle: false`. It must be uploaded byte-for-byte: re-bundling would
// inline the imports below and collapse the module graph this test
// asserts on.
import { greeting } from "./lib/greeting.mjs";

export default {
  async fetch() {
    return new Response(greeting, {
      headers: { "x-alchemy-prebuilt": "7c2e" },
    });
  },
};
