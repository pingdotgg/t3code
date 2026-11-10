import react from "@vitejs/plugin-react";
import rsc from "@vitejs/plugin-rsc";
import { defineConfig } from "vite";

// Minimal React Router app (hand-rolled on @vitejs/plugin-rsc). The Worker IS
// the `rsc` environment; its fetch handler loads the `ssr` environment at
// runtime via `import.meta.viteRsc.loadModule("ssr", ...)`. The Cloudflare
// plugin configuration, including the `viteEnvironments` option that declares
// this entry/child topology, lives in `e2e.config.ts`.
export default defineConfig({
  plugins: [
    react(),
    rsc({
      serverHandler: false,
      entries: {
        client: "./react-router-vite/entry.browser.tsx",
        ssr: "./react-router-vite/entry.ssr.tsx",
        rsc: "./react-router-vite/entry.worker.tsx",
      },
    }),
  ],
  optimizeDeps: {
    include: ["react-router", "react-router/internal/react-server-client"],
  },
});
