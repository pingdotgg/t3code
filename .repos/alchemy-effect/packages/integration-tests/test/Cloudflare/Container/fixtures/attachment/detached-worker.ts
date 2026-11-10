// The detached shape of `worker.ts`: Cloudflare rejects dropping a Durable
// Object class whose export is still in the uploaded code.
export default {
  fetch() {
    return new Response("detached");
  },
};
