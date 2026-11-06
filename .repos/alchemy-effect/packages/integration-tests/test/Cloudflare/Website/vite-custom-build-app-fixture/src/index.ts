// Mirrors `@cloudflare/vite-plugin`'s `playground/custom-build-app`.
export default {
  async fetch() {
    return new Response("Worker response");
  },
};
