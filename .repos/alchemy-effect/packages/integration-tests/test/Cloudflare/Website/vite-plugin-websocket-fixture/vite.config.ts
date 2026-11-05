// A Vite plugin that serves its own WebSockets on the dev server, as
// `@foldkit/vite-plugin` serves its DevTools relay (#2191). The Worker has
// no route for the paths, so the dev server must leave the sockets to the
// plugin: `/__echo` is taken at once, `/__echo-async` only after an `await`
// (as Vite's `server.proxy` awaits its `bypass`), once the Worker has
// already answered.
import type { Plugin } from "vite";
import { WebSocketServer } from "ws";

const echoPlugin: Plugin = {
  name: "ws-echo",
  configureServer(server) {
    const wss = new WebSocketServer({ noServer: true });
    server.httpServer?.on("upgrade", async (request, socket, head) => {
      if (request.url !== "/__echo" && request.url !== "/__echo-async") return;
      if (request.url === "/__echo-async") {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        ws.on("message", (data) => ws.send(`echo ${data}`));
      });
    });
  },
};

export default { plugins: [echoPlugin] };
