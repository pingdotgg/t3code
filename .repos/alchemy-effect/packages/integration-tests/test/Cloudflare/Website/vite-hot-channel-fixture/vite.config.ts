// Mirrors `@cloudflare/vite-plugin`'s `playground/hot-channel/vite.config.ts`:
// the dev server and the Worker exchange custom events over the Worker
// environment's hot channel.
import type { Plugin, ViteDevServer } from "vite";

const hotChannelPlugin: Plugin = {
  name: "test-plugin",
  configureServer(server: ViteDevServer) {
    const worker = server.environments.ssr;
    if (!worker) throw new Error("'ssr' environment not found");
    return () => {
      server.middlewares.use((_request, _response, next) => {
        worker.hot.on("worker-event", (payload) => {
          worker.hot.send("worker-event-received", payload);
        });
        worker.hot.send("server-event", "server-event-data");
        next();
      });
    };
  },
};

export default { plugins: [hotChannelPlugin] };
