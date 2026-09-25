/// <reference types="@cloudflare/workers-types" />

// Minimal worker fixture for AssetsRouting.local.test.ts. Echoes the path so
// the test can tell which layer (user worker vs assets) answered a request.
export default {
  fetch: async (request: Request) => {
    const url = new URL(request.url);
    return new Response(`assets-routing-worker:${url.pathname}`);
  },
};
