import react from "@vitejs/plugin-react";
import rsc from "@vitejs/plugin-rsc";
import { defineConfig } from "vite";

// React Router RSC wired directly on @vitejs/plugin-rsc. Alchemy injects the
// distilled Cloudflare Vite plugin at build/dev time through Cloudflare.Vite.
export default defineConfig({
  clearScreen: false,
  build: { minify: false },
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
  environments: {
    // The Worker is the RSC environment. Alchemy passes this environment
    // topology to the distilled plugin via Cloudflare.Vite.
    rsc: {
      build: {
        rollupOptions: {
          input: { "entry.worker": "./react-router-vite/entry.worker.tsx" },
        },
      },
    },
    // A second `ssr` input the worker loads on demand via
    // loadModule("ssr", "worker-ssr") — alongside the framework's `index`.
    ssr: {
      build: {
        rollupOptions: {
          input: { "worker-ssr": "./react-router-vite/worker-ssr.tsx" },
        },
      },
    },
  },
  optimizeDeps: {
    include: ["react-router", "react-router/internal/react-server-client"],
  },
});
