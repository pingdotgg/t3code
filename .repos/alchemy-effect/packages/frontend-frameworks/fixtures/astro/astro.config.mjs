// @ts-check
// Real user config file. The toolchain must load this NATIVELY (astro's own
// config discovery) and merge its inline overlay OVER it — nothing here works
// unless the file is honored:
//
// - `integrations`: a user integration injecting the on-demand
//   `/user-integration` route (the "does react/mdx/tailwind work?" proof).
// - `vite.define`: a user Vite setting observable in the rendered HTML.
//
// No `adapter` — the deploy target provides it (declaring one here fails the
// build with an actionable error).
import { defineConfig } from "astro/config";

/** @returns {import("astro").AstroIntegration} */
const userIntegration = () => ({
  name: "fixture-user-integration",
  hooks: {
    "astro:config:setup": ({ injectRoute }) => {
      injectRoute({
        pattern: "/user-integration",
        entrypoint: new URL("./src/user-integration.astro", import.meta.url),
      });
    },
  },
});

export default defineConfig({
  // On-demand rendering with per-page `export const prerender = true`
  // opt-ins. The toolchain no longer defaults `output` (astro's own default
  // is `"static"`), so the SSR-first intent is declared here — and honoring
  // it is itself part of the user-config proof.
  output: "server",
  integrations: [userIntegration()],
  vite: {
    define: {
      __USER_VITE_DEFINE__: JSON.stringify("hello-from-user-vite-define"),
    },
  },
});
