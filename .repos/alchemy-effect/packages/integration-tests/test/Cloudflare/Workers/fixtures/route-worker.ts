/// <reference types="@cloudflare/workers-types" />

// Minimal worker fixture used by Route.test.ts. The handler body is a
// no-op — the tests assert against the route registration, not against
// request delivery.
export default {
  fetch: async () => new Response("route-ok"),
};
