/**
 * Async (non-Effect) canvas Function. Alchemy bundles this file as-is —
 * no Effect runtime — and the wrapper calls `fetch(request, process.env)`.
 */
export default {
  async fetch(): Promise<Response> {
    return new Response("ok");
  },
};
