/// <reference types="@cloudflare/workers-types" />

// Minimal OTLP "collector" fixture used by ObservabilityDestination.test.ts.
// Cloudflare preflights an observability destination's endpoint with a POST
// and requires a 2xx — this worker answers 200 to everything so in-place
// updates (which always re-run the preflight) can converge.
export default {
  fetch: async () => new Response("sink-ok"),
};
