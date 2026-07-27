import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface ListPlatformApplicationsRequest
  extends sns.ListPlatformApplicationsInput {}

/**
 * Runtime binding for `sns:ListPlatformApplications`.
 *
 * An account-scoped operation — pages through the mobile-push platform
 * applications in the account/region.
 * Provide the `ListPlatformApplicationsHttp` layer on the Function to implement the binding.
 * @binding
 * @section Mobile Push
 * @example List Platform Applications
 * ```typescript
 * const listApplications = yield* SNS.ListPlatformApplications();
 * const { PlatformApplications } = yield* listApplications();
 * ```
 */
export interface ListPlatformApplications extends Binding.Service<
  ListPlatformApplications,
  "AWS.SNS.ListPlatformApplications",
  () => Effect.Effect<
    (
      request?: ListPlatformApplicationsRequest,
    ) => Effect.Effect<
      sns.ListPlatformApplicationsResponse,
      sns.ListPlatformApplicationsError
    >
  >
> {}

export const ListPlatformApplications =
  Binding.Service<ListPlatformApplications>("AWS.SNS.ListPlatformApplications");
