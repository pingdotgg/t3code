import type * as emr from "@distilled.cloud/aws/emr-serverless";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";

/**
 * Request accepted by the {@link GetSession} runtime callable. The
 * `applicationId` is injected from the bound {@link Application}.
 */
export type GetSessionInput = Omit<emr.GetSessionRequest, "applicationId">;

/**
 * Runtime binding for `emr-serverless:GetSession`.
 *
 * Reads an interactive session's detail on the bound {@link Application} —
 * state, execution role, idle time, resource utilization. Provide the
 * implementation with `Effect.provide(AWS.EMRServerless.GetSessionHttp)`.
 * @binding
 * @section Interactive Sessions
 * @example Poll A Session
 * ```typescript
 * // init
 * const getSession = yield* AWS.EMRServerless.GetSession(app);
 *
 * // runtime
 * const { session } = yield* getSession({ sessionId });
 * yield* Effect.log(`${session.sessionId} is ${session.state}`);
 * ```
 */
export interface GetSession extends Binding.Service<
  GetSession,
  "AWS.EMRServerless.GetSession",
  (
    application: Application,
  ) => Effect.Effect<
    (
      request: GetSessionInput,
    ) => Effect.Effect<emr.GetSessionResponse, emr.GetSessionError>
  >
> {}
export const GetSession = Binding.Service<GetSession>(
  "AWS.EMRServerless.GetSession",
);
