import type * as emr from "@distilled.cloud/aws/emr-serverless";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";

/**
 * Request accepted by the {@link StartSession} runtime callable. The
 * `applicationId` is injected from the bound {@link Application}; the
 * idempotency `clientToken` is auto-generated when omitted.
 */
export type StartSessionInput = Omit<
  emr.StartSessionRequest,
  "applicationId" | "clientToken"
> & {
  /**
   * Idempotency token deduplicating retried submissions.
   * @default a generated UUID per call
   */
  clientToken?: string;
};

/**
 * Runtime binding for `emr-serverless:StartSession`.
 *
 * Starts an interactive session on the bound {@link Application} (the
 * application must enable `interactiveConfiguration`). The session assumes
 * the given execution role; grants `iam:PassRole` (conditioned to
 * `emr-serverless.amazonaws.com`) accordingly. Provide the implementation
 * with `Effect.provide(AWS.EMRServerless.StartSessionHttp)`.
 * @binding
 * @section Interactive Sessions
 * @example Start A Session
 * ```typescript
 * // init
 * const startSession = yield* AWS.EMRServerless.StartSession(app);
 *
 * // runtime
 * const session = yield* startSession({ executionRoleArn: sessionRoleArn });
 * yield* Effect.log(`started ${session.sessionId}`);
 * ```
 */
export interface StartSession extends Binding.Service<
  StartSession,
  "AWS.EMRServerless.StartSession",
  (
    application: Application,
  ) => Effect.Effect<
    (
      request: StartSessionInput,
    ) => Effect.Effect<emr.StartSessionResponse, emr.StartSessionError>
  >
> {}
export const StartSession = Binding.Service<StartSession>(
  "AWS.EMRServerless.StartSession",
);
