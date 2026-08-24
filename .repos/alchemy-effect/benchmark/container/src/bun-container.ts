import * as Cloudflare from "alchemy/Cloudflare";

/**
 * Non-Effect container built from a Dockerfile whose base image is the *same*
 * `oven/bun:latest` the effectful variant uses — but with no Effect program
 * bundled, just a raw `Bun.serve`. Comparing this against the effectful variant
 * rules out base-image pull/boot time as the cause of any gap: the remaining
 * difference is the bundled Effect runtime.
 */
export class BunContainer extends Cloudflare.Container<BunContainer>()(
  "BenchBunContainer",
  {
    context: `${import.meta.dirname}/../contexts/bun`,
    maxInstances: 100,
    instanceType: "lite",
    instances: 0,
  },
) {}
