import type * as quicksight from "@distilled.cloud/aws/quicksight";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Dashboard } from "./Dashboard.ts";

/**
 * Request for {@link GenerateEmbedUrlForRegisteredUser}. `AwsAccountId` is
 * injected from the bound dashboard's ARN; `ExperienceConfiguration`
 * defaults to embedding the bound dashboard when omitted.
 */
export interface GenerateEmbedUrlForRegisteredUserRequest extends Omit<
  quicksight.GenerateEmbedUrlForRegisteredUserRequest,
  "AwsAccountId" | "ExperienceConfiguration"
> {
  /**
   * The Quick Sight experience to embed.
   * @default the bound dashboard
   */
  ExperienceConfiguration?: quicksight.RegisteredUserEmbeddingExperienceConfiguration;
}

/**
 * Runtime binding for `quicksight:GenerateEmbedUrlForRegisteredUser`.
 *
 * Generates a single-use embed URL for a registered QuickSight user, defaulting
 * the embedded experience to the bound {@link Dashboard}. The URL contains a
 * temporary bearer token valid for 5 minutes; the resulting session lasts
 * 15 minutes to 10 hours (`SessionLifetimeInMinutes`). Provide the
 * implementation with
 * `Effect.provide(AWS.QuickSight.GenerateEmbedUrlForRegisteredUserHttp)`.
 * @binding
 * @section Embedding Dashboards
 * @example Embed The Bound Dashboard For A Registered User
 * ```typescript
 * // init — bind the operation to the dashboard
 * const generateEmbedUrl =
 *   yield* AWS.QuickSight.GenerateEmbedUrlForRegisteredUser(dashboard);
 *
 * // runtime — the embed experience defaults to the bound dashboard
 * const { EmbedUrl } = yield* generateEmbedUrl({
 *   UserArn: userArn,
 *   SessionLifetimeInMinutes: 60,
 * });
 * ```
 */
export interface GenerateEmbedUrlForRegisteredUser extends Binding.Service<
  GenerateEmbedUrlForRegisteredUser,
  "AWS.QuickSight.GenerateEmbedUrlForRegisteredUser",
  (
    dashboard: Dashboard,
  ) => Effect.Effect<
    (
      request: GenerateEmbedUrlForRegisteredUserRequest,
    ) => Effect.Effect<
      quicksight.GenerateEmbedUrlForRegisteredUserResponse,
      quicksight.GenerateEmbedUrlForRegisteredUserError
    >
  >
> {}
export const GenerateEmbedUrlForRegisteredUser =
  Binding.Service<GenerateEmbedUrlForRegisteredUser>(
    "AWS.QuickSight.GenerateEmbedUrlForRegisteredUser",
  );
