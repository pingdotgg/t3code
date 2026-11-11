import { foldkit } from "@foldkit/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    foldkit({
      ssr: {
        serverEntry: "/src/entry.server.ts",
        clientEntry: "/src/entry.ts",
        // One `vite build` emits the browser bundle, `dist/server/fetch.js`
        // and `foldkit.build.json`, and prerenders whatever
        // `src/prerender.ts` lists.
        build: { prerender: true },
      },
    }),
  ],
});
