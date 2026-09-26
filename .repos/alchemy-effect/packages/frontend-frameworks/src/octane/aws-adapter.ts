/**
 * `@alchemy.run/frontend-frameworks/octane/aws-adapter` — the Octane deploy
 * adapter an AWS-targeted project selects in its `octane.config.ts`:
 *
 * ```ts
 * import { aws } from "@alchemy.run/frontend-frameworks/octane/aws-adapter";
 * import { defineConfig } from "@octanejs/vite-plugin";
 *
 * export default defineConfig({
 *   adapter: aws(),
 *   // ...
 * });
 * ```
 *
 * Octane's default (adapter-less) production build is already the AWS Lambda
 * programming model: with `serverTarget: "node"` the server sub-build emits
 * `dist/server/entry.js`, a self-contained Node ESM bundle exporting a
 * web-standard fetch `handler` (plus a Node `(req, res)` wrapper) that only
 * auto-boots a listener when run directly. So this adapter is a pure marker —
 * `name: "aws"` satisfies the AWS deploy target's adapter validation, and it
 * deliberately defines no `adapt()` pass (the target's finishing pass emits
 * the Lambda entry) and no `runtime` overrides (the entry's Node defaults —
 * `node:crypto` hashing and `AsyncLocalStorage` — are exactly right on the
 * Lambda Node.js runtime).
 *
 * This module MUST stay dependency-free: `octane.config.ts` (and therefore
 * its import graph) is bundled into the server entry by Octane's
 * `noExternal: true` server sub-build, and is also evaluated by Octane's
 * config loader inside a Vite module runner.
 */

/** The `adapter.name` this adapter declares (matched by the AWS target). */
export const ADAPTER_NAME = "aws";

/** The shape of the Octane deploy adapter this module produces. */
export interface OctaneAwsAdapter {
  readonly name: typeof ADAPTER_NAME;
  readonly serverTarget: "node";
}

/**
 * Create the AWS deploy adapter for `octane.config.ts`
 * (`adapter: aws()`). See the module doc.
 */
export const aws = (): OctaneAwsAdapter => ({
  name: ADAPTER_NAME,
  serverTarget: "node",
});

export default aws;
