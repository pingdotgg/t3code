/// <reference types="@cloudflare/workers-types" />

// Minimal worker fixture used by WorkerDomainDns.test.ts: answers every
// request on its custom domain (native or Cloudflare for SaaS).
export default {
  fetch: async () => new Response("worker-dns-ok"),
};
