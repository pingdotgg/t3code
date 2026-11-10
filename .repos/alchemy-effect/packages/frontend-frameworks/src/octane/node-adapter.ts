/**
 * Optional legacy Node marker adapter, retained for existing Octane configs.
 * New projects can omit it: the `Website.Octane` resource selects hosting
 * and wraps Octane's default native Node output as an HTTP server automatically.
 *
 * This marker sets `name: "node"` and `serverTarget: "node"` without an
 * `adapt()` pass. Octane emits `dist/server/entry.js`, a self-contained Node
 * ESM bundle exporting a web-standard fetch `handler`; the Node deploy
 * target's finishing pass emits the HTTP serve entry.
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
 * Create the optional legacy Node marker adapter. New projects can omit it
 * from `octane.config.ts`; the `Website.Octane` resource owns deployment.
 */
export const node = (): OctaneNodeAdapter => ({
  name: ADAPTER_NAME,
  serverTarget: "node",
});

export default node;
