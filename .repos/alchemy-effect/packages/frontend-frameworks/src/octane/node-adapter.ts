/**
 * `@alchemy.run/frontend-frameworks/octane/node-adapter` — the Octane deploy
 * adapter a Node-targeted project selects in its `octane.config.ts`:
 *
 * ```ts
 * import { node } from "@alchemy.run/frontend-frameworks/octane/node-adapter";
 * import { defineConfig } from "@octanejs/vite-plugin";
 *
 * export default defineConfig({
 *   adapter: node(),
 *   // ...
 * });
 * ```
 *
 * Octane's default (adapter-less) production build is already a Node server
 * bundle: with `serverTarget: "node"` the server sub-build emits
 * `dist/server/entry.js`, a self-contained Node ESM bundle exporting a
 * web-standard fetch `handler`. This adapter is a pure marker — `name:
 * "node"` satisfies the Node deploy target's adapter validation, and it
 * deliberately defines no `adapt()` pass (the target's finishing pass emits
 * the HTTP serve entry).
 *
 * This module MUST stay dependency-free: `octane.config.ts` (and therefore
 * its import graph) is bundled into the server entry by Octane's
 * `noExternal: true` server sub-build, and is also evaluated by Octane's
 * config loader inside a Vite module runner.
 */

/** The `adapter.name` this adapter declares (matched by the Node target). */
export const ADAPTER_NAME = "node";

/** The shape of the Octane deploy adapter this module produces. */
export interface OctaneNodeAdapter {
  readonly name: typeof ADAPTER_NAME;
  readonly serverTarget: "node";
}

/**
 * Create the Node deploy adapter for `octane.config.ts`
 * (`adapter: node()`). See the module doc.
 */
export const node = (): OctaneNodeAdapter => ({
  name: ADAPTER_NAME,
  serverTarget: "node",
});

export default node;
