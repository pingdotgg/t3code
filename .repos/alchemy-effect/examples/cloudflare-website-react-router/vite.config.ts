import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import rsc from "@vitejs/plugin-rsc";
import { defineConfig } from "vite";

// React Router RSC wired directly on @vitejs/plugin-rsc. Alchemy injects
// its Cloudflare Vite plugin on top of this config at build and dev time,
// so there is nothing Cloudflare-specific to add here.
export default defineConfig({
  plugins: [
    tailwindcss(),
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
    // The Worker is the RSC environment.
    rsc: {
      build: {
        rollupOptions: {
          input: { "entry.worker": "./react-router-vite/entry.worker.tsx" },
        },
      },
    },
    // A second `ssr` input the Worker loads on demand via
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
