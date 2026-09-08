/**
 * A REAL user-owned Vite config, exactly like a normal SvelteKit v3 project:
 * `sveltekit()` is registered here by the user (kit v3 has no
 * `svelte.config.js` — all kit options live in this call), alongside a user
 * Vite plugin. `@alchemy.run/frontend-frameworks/sveltekit` must load this file natively and
 * inject its deploy-target adapter into THIS `sveltekit(...)` instance rather
 * than constructing a second one.
 *
 * The suite proves the file is honored end-to-end (`/api/user-config`, live
 * and dev):
 *
 * - `alias: { $fixture: ... }` — a user kit option that only works if the
 *   user's `sveltekit()` call is the one that runs.
 * - `fixtureMarkerPlugin` — a user Vite plugin whose virtual module is
 *   observable in the build output.
 * - `adapter: userDeclaredAdapter` — a user-declared adapter that THROWS if
 *   it ever runs: the integration must replace it (with a warning) with the
 *   deploy target's adapter, so a green build is proof of the override.
 */
import type { Adapter } from "@sveltejs/kit";
import { sveltekit } from "@sveltejs/kit/vite";
import type { Plugin } from "vite";
import { defineConfig } from "vite";

const VIRTUAL_ID = "virtual:fixture-marker";
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

const fixtureMarkerPlugin = (): Plugin => ({
  name: "fixture-user-vite-plugin",
  resolveId(id) {
    if (id === VIRTUAL_ID) {
      return RESOLVED_ID;
    }
  },
  load(id) {
    if (id === RESOLVED_ID) {
      return `export const marker = "user-vite-plugin-active";`;
    }
  },
});

const userDeclaredAdapter: Adapter = {
  name: "fixture-user-adapter",
  adapt() {
    throw new Error(
      "fixture-user-adapter ran — the integration failed to inject the deploy target's adapter",
    );
  },
};

export default defineConfig({
  plugins: [
    fixtureMarkerPlugin(),
    sveltekit({
      adapter: userDeclaredAdapter,
      alias: { $fixture: "src/fixture" },
    }),
  ],
});
