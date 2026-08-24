import type * as emr from "@distilled.cloud/aws/emr-serverless";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";

/**
 * Request accepted by the {@link ListSessions} runtime callable. The
 * `applicationId` is injected from the bound {@link Application}.
 */
export type ListSessionsInput = Omit<emr.ListSessionsRequest, "applicationId">;

/**
 * Runtime binding for `emr-serverless:ListSessions`.
 *
 * Enumerates interactive sessions on the bound {@link Application},
 * optionally filtered by state or creation window. Provide the
 * implementation with `Effect.provide(AWS.EMRServerless.ListSessionsHttp)`.
 * @binding
 * @section Interactive Sessions
 * @example List Idle Sessions
 * ```typescript
 * // init
 * const listSessions = yield* AWS.EMRServerless.ListSessions(app);
 *
 * // runtime
 * const { sessions } = yield* listSessions({ states: ["IDLE"] });
 * ```
 */
export interface ListSessions extends Binding.Service<
  ListSessions,
  "AWS.EMRServerless.ListSessions",
  (
    application: Application,
  ) => Effect.Effect<
    (
      request?: ListSessionsInput,
    ) => Effect.Effect<emr.ListSessionsResponse, emr.ListSessionsError>
  >
> {}
export const ListSessions = Binding.Service<ListSessions>(
  "AWS.EMRServerless.ListSessions",
);
