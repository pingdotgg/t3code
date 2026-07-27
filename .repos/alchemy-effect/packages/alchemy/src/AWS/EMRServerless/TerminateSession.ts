import type * as emr from "@distilled.cloud/aws/emr-serverless";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";

/**
 * Request accepted by the {@link TerminateSession} runtime callable. The
 * `applicationId` is injected from the bound {@link Application}.
 */
export type TerminateSessionInput = Omit<
  emr.TerminateSessionRequest,
  "applicationId"
>;

/**
 * Runtime binding for `emr-serverless:TerminateSession`.
 *
 * Terminates an interactive session on the bound {@link Application},
 * releasing its workers — e.g. a cost-control function reaping sessions
 * left idle past a policy window. Provide the implementation with
 * `Effect.provide(AWS.EMRServerless.TerminateSessionHttp)`.
 * @binding
 * @section Interactive Sessions
 * @example Terminate A Session
 * ```typescript
 * // init
 * const terminateSession = yield* AWS.EMRServerless.TerminateSession(app);
 *
 * // runtime
 * yield* terminateSession({ sessionId });
 * ```
 */
export interface TerminateSession extends Binding.Service<
  TerminateSession,
  "AWS.EMRServerless.TerminateSession",
  (
    application: Application,
  ) => Effect.Effect<
    (
      request: TerminateSessionInput,
    ) => Effect.Effect<emr.TerminateSessionResponse, emr.TerminateSessionError>
  >
> {}
export const TerminateSession = Binding.Service<TerminateSession>(
  "AWS.EMRServerless.TerminateSession",
);
