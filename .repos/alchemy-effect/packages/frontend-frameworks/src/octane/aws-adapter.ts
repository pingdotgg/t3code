/**
 * Optional legacy AWS marker adapter, retained for existing Octane configs.
 * New projects can omit it: `AWS.Website.Octane` selects hosting and wraps
 * Octane's default native Node output as a Lambda handler automatically.
 *
 * This marker sets `name: "aws"` and `serverTarget: "node"` without an
 * `adapt()` pass or runtime overrides. Octane emits `dist/server/entry.js`,
 * a self-contained Node ESM bundle exporting a web-standard fetch `handler`;
 * the AWS deploy target's finishing pass emits the Lambda entry.
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
 * Create the optional legacy AWS marker adapter. New projects can omit it
 * from `octane.config.ts`; `AWS.Website.Octane` owns deployment.
 */
export const aws = (): OctaneAwsAdapter => ({
  name: ADAPTER_NAME,
  serverTarget: "node",
});

export default aws;
