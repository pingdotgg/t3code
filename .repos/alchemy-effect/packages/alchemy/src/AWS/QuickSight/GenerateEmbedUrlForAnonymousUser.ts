import type * as quicksight from "@distilled.cloud/aws/quicksight";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Dashboard } from "./Dashboard.ts";

/**
 * Request for {@link GenerateEmbedUrlForAnonymousUser}. `AwsAccountId` is
 * injected from the bound dashboard's ARN; `Namespace`,
 * `AuthorizedResourceArns`, and `ExperienceConfiguration` default to the
 * `default` namespace and the bound dashboard when omitted.
 */
export interface GenerateEmbedUrlForAnonymousUserRequest extends Omit<
  quicksight.GenerateEmbedUrlForAnonymousUserRequest,
  | "AwsAccountId"
  | "Namespace"
  | "AuthorizedResourceArns"
  | "ExperienceConfiguration"
> {
  /**
   * The QuickSight namespace the anonymous session belongs to.
   * @default "default"
   */
  Namespace?: string;

  /**
   * The ARNs the anonymous session is authorized to access.
   * @default the bound dashboard's ARN
   */
  AuthorizedResourceArns?: string[];

  /**
   * The Quick Sight experience to embed.
   * @default the bound dashboard
   */
  ExperienceConfiguration?: quicksight.AnonymousUserEmbeddingExperienceConfiguration;
}

/**
 * Runtime binding for `quicksight:GenerateEmbedUrlForAnonymousUser`.
 *
 * Generates a single-use embed URL for an anonymous (unregistered) visitor,
 * defaulting the authorized resources and embedded experience to the bound
 * {@link Dashboard}. Requires a QuickSight account with session-capacity
 * pricing. Provide the implementation with
 * `Effect.provide(AWS.QuickSight.GenerateEmbedUrlForAnonymousUserHttp)`.
 * @binding
 * @section Embedding Dashboards
 * @example Embed The Bound Dashboard Anonymously
 * ```typescript
 * // init — bind the operation to the dashboard
 * const generateEmbedUrl =
 *   yield* AWS.QuickSight.GenerateEmbedUrlForAnonymousUser(dashboard);
 *
 * // runtime — namespace, authorized ARNs, and experience default to the dashboard
 * const { EmbedUrl } = yield* generateEmbedUrl({
 *   SessionLifetimeInMinutes: 60,
 * });
 * ```
 */
export interface GenerateEmbedUrlForAnonymousUser extends Binding.Service<
  GenerateEmbedUrlForAnonymousUser,
  "AWS.QuickSight.GenerateEmbedUrlForAnonymousUser",
  (
    dashboard: Dashboard,
  ) => Effect.Effect<
    (
      request?: GenerateEmbedUrlForAnonymousUserRequest,
    ) => Effect.Effect<
      quicksight.GenerateEmbedUrlForAnonymousUserResponse,
      quicksight.GenerateEmbedUrlForAnonymousUserError
    >
  >
> {}
export const GenerateEmbedUrlForAnonymousUser =
  Binding.Service<GenerateEmbedUrlForAnonymousUser>(
    "AWS.QuickSight.GenerateEmbedUrlForAnonymousUser",
  );
