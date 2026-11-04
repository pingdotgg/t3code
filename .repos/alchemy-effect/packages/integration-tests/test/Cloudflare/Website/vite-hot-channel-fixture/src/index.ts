/// <reference types="vite/client" />
// Mirrors `playground/hot-channel/src/index.ts`, recording the events it
// receives (the playground logs them) so the test can read them back.
const received = new Set<string>();

import.meta.hot?.on("server-event", (payload: string) => {
  received.add(`__${payload}-received__`);
  import.meta.hot?.send("worker-event", "worker-module-event-data");
});

import.meta.hot?.on("worker-event-received", (payload: string) => {
  received.add(`__${payload}-received__`);
});

export default {
  async fetch() {
    import.meta.hot?.send("worker-event", "worker-request-event-data");
    return Response.json([...received].sort());
  },
};
