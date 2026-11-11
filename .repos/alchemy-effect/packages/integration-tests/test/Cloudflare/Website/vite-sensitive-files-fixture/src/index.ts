// Mirrors `@cloudflare/vite-plugin`'s `playground/sensitive-files`: every
// path reaches the Worker unless the dev server refuses it first.
export default {
  async fetch() {
    return new Response("Worker A response");
  },
};
