import type * as greengrassv2 from "@distilled.cloud/aws/greengrassv2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `greengrass:ResolveComponentCandidates`.
 *
 * Resolves a set of component candidates against a target platform,
 * returning the exact component versions (and their recipes) that satisfy
 * the version requirements — the same dependency-resolution API the
 * Greengrass nucleus calls during a deployment. Provide the implementation
 * with `Effect.provide(AWS.GreengrassV2.ResolveComponentCandidatesHttp)`.
 *
 * NOTE: per the AWS API reference, this operation must be called through the
 * Greengrass **data plane** endpoint authenticated with an AWS IoT device
 * certificate. Calls signed with plain IAM credentials (e.g. from a Lambda
 * role) are rejected with a typed `AccessDeniedException` even when the
 * `greengrass:ResolveComponentCandidates` permission is granted — use this
 * binding only from device-credentialed contexts.
 * @binding
 * @section Reading Components
 * @example Resolve Versions For A Platform
 * ```typescript
 * // init — account-level binding, no resource argument
 * const resolveComponentCandidates =
 *   yield* AWS.GreengrassV2.ResolveComponentCandidates();
 *
 * // runtime
 * const { resolvedComponentVersions } = yield* resolveComponentCandidates({
 *   platform: { attributes: { os: "linux", architecture: "amd64" } },
 *   componentCandidates: [
 *     { componentName: "com.example.Hello", versionRequirements: { req: ">=1.0.0" } },
 *   ],
 * });
 * ```
 */
export interface ResolveComponentCandidates extends Binding.Service<
  ResolveComponentCandidates,
  "AWS.GreengrassV2.ResolveComponentCandidates",
  () => Effect.Effect<
    (
      request?: greengrassv2.ResolveComponentCandidatesRequest,
    ) => Effect.Effect<
      greengrassv2.ResolveComponentCandidatesResponse,
      greengrassv2.ResolveComponentCandidatesError
    >
  >
> {}
export const ResolveComponentCandidates =
  Binding.Service<ResolveComponentCandidates>(
    "AWS.GreengrassV2.ResolveComponentCandidates",
  );
