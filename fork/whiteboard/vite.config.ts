// Exposes the Vite development and build configuration for the web client.
import * as NodeURL from "node:url";
import { defineConfig, type Connect, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { config } from "./server/config.mjs";
import { hostHeaderName, pageMode } from "./web/pageMode";

// Vite's client also supplies the helpers used by dev-mode CSS, so it must remain available.
// Disconnect only its HMR transport: otherwise any brief socket loss makes the client reload the
// entire board. The marker guard makes a future Vite client change fail loudly during startup.
const hmrConnectMarker = "transport.connect(createHMRHandler(handleMessage));";
const disableHmrTransport = {
  name: "whiteboard:disable-hmr-transport",
  apply: "serve",
  enforce: "post",
  transform(code, id) {
    if (!id.replaceAll("\\", "/").endsWith("/vite/dist/client/client.mjs")) return;
    if (!code.includes(hmrConnectMarker))
      throw new Error("Vite client HMR connection marker not found");
    return code.replace(
      hmrConnectMarker,
      "/* HMR transport disabled for the persistent whiteboard. */",
    );
  },
} satisfies Plugin;

// Bare / on an "app" hostname is the chat; redirect before the board's code loads.
const appRedirect: Connect.NextHandleFunction = (req, res, next) => {
  const url = new URL(req.url ?? "/", "http://host");
  if (req.method !== "GET" || url.pathname !== "/") return next();
  const mode = pageMode({
    hostname: hostHeaderName(req.headers.host ?? ""),
    search: url.search,
    framed: false,
    openViews: config.openViews,
  });
  if (mode.kind !== "redirect") return next();
  res.writeHead(302, { Location: mode.to }).end();
};
const appRedirectPlugin = {
  name: "whiteboard:app-redirect",
  configureServer: (server) => void server.middlewares.use(appRedirect),
  configurePreviewServer: (server) => void server.middlewares.use(appRedirect),
} satisfies Plugin;

export default defineConfig({
  plugins: [react(), disableHmrTransport, appRedirectPlugin],
  resolve: { dedupe: ["prosemirror-state"] },
  define: { __OPEN_VIEWS__: JSON.stringify(config.openViews) },
  build: {
    rollupOptions: {
      input: {
        main: NodeURL.fileURLToPath(new URL("index.html", import.meta.url)),
        mermaid: NodeURL.fileURLToPath(new URL("mermaid.html", import.meta.url)),
      },
    },
  },
  server: {
    hmr: false,
    port: config.webPort,
    strictPort: true,
    // Vite refuses other Host headers, so a reverse proxy in front needs its hostname listed here.
    allowedHosts: config.allowedHosts,
    proxy: {
      "/sync": {
        target: `http://127.0.0.1:${config.port}`,
        ws: true,
        rewrite: (path) => path.replace(/^\/sync/, ""),
      },
      "/chat": {
        target: `http://127.0.0.1:${config.chatPort}`,
        ws: true,
        rewrite: (path) => path.replace(/^\/chat/, ""),
      },
      // The chat's browser code builds these from the page origin, so they reach it unprefixed.
      "/api": { target: `http://127.0.0.1:${config.chatPort}`, ws: true },
      "/ws": { target: `http://127.0.0.1:${config.chatPort}`, ws: true },
      "/.well-known": { target: `http://127.0.0.1:${config.chatPort}`, ws: true },
    },
  },
});
