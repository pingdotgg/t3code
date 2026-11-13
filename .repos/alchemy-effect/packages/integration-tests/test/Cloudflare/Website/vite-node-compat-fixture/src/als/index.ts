import { AsyncLocalStorage } from "node:async_hooks";

export default {
  async fetch() {
    const storage = new AsyncLocalStorage();
    return storage.run({}, () => new Response("OK!"));
  },
} satisfies ExportedHandler;
