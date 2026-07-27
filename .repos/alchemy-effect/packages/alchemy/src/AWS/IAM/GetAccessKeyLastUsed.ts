import type * as iam from "@distilled.cloud/aws/iam";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { AccessKey } from "./AccessKey.ts";

/**
 * Runtime binding for `iam:GetAccessKeyLastUsed` — read when (and against
 * which service/region) a bound {@link AccessKey} last authenticated. The
 * primitive behind key-rotation and stale-credential reapers.
 *
 * Bind a canonical `AccessKey`; the runtime callable injects the key's
 * `AccessKeyId`. AWS scopes the action to the owning *user*, whose exact
 * path-qualified ARN is not derivable from the key, so the grant is
 * `iam:GetAccessKeyLastUsed` on `*`. Provide the implementation with
 * `Effect.provide(AWS.IAM.GetAccessKeyLastUsedHttp)`.
 *
 * @binding
 * @section Access Key Hygiene
 * @example Check When a Key Was Last Used
 * ```typescript
 * // init
 * const getAccessKeyLastUsed = yield* IAM.GetAccessKeyLastUsed(accessKey);
 *
 * // runtime
 * const { AccessKeyLastUsed, UserName } = yield* getAccessKeyLastUsed();
 * const lastUsed = AccessKeyLastUsed?.LastUsedDate;
 * ```
 */
export interface GetAccessKeyLastUsed extends Binding.Service<
  GetAccessKeyLastUsed,
  "AWS.IAM.GetAccessKeyLastUsed",
  <K extends AccessKey>(
    accessKey: K,
  ) => Effect.Effect<
    () => Effect.Effect<
      iam.GetAccessKeyLastUsedResponse,
      iam.GetAccessKeyLastUsedError
    >
  >
> {}
export const GetAccessKeyLastUsed = Binding.Service<GetAccessKeyLastUsed>(
  "AWS.IAM.GetAccessKeyLastUsed",
);
