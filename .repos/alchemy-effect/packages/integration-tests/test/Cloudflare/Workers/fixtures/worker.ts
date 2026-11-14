export default {
  fetch: async () => {
    return new Response("Hello from TestWorker");
  },
  queue: async () => {},
};
