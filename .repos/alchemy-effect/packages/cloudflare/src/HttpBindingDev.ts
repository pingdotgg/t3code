import { describeDataPlane } from "alchemy/Provider";
import type { ProviderMode } from "alchemy/ProviderMode";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

/**
 * A token-scoped `*Http` binding bound to a resource that `alchemy dev`
 * emulates locally. The HTTP client calls the real Cloudflare API with a
 * real token, which can't reach the local simulator's `dev:` resources.
 */
export class HttpBindingUnsupportedInDev extends Data.TaggedError(
  "Cloudflare.HttpBindingUnsupportedInDev",
)<{
  message: string;
  logicalId: string;
}> {}

/**
 * Fail an `*Http` binding at deploy time when its resource is emulated
 * locally. Resources opted out with `Alchemy.remote()` and types with no
 * local provider run live, so their HTTP bindings keep working in dev.
 */
export const requireLiveResource = Effect.fn(function* (resource: {
  readonly Type: string;
  readonly LogicalId: string;
  readonly Mode?: ProviderMode | undefined;
}) {
  const plane = yield* describeDataPlane(resource);
  if (plane.kind === "local" || plane.kind === "undeclared") {
    return yield* Effect.die(
      new HttpBindingUnsupportedInDev({
        logicalId: resource.LogicalId,
        message:
          `${resource.Type} ${resource.LogicalId} is emulated locally, and Cloudflare HTTP bindings ` +
          "(`*Http`) are not supported against local resources in `alchemy dev`. Use the native " +
          "binding (`*Binding`) on a Worker, or opt the resource out of local emulation with " +
          "`Alchemy.remote()`.",
      }),
    );
  }
});
