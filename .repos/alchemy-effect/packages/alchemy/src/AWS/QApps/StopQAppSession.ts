import type * as qapps from "@distilled.cloud/aws/qapps";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { QApp } from "./QApp.ts";

/**
 * Request for {@link StopQAppSession} — `instanceId` is injected from the bound Q App.
 */
export interface StopQAppSessionRequest extends Omit<
  qapps.StopQAppSessionInput,
  "instanceId" | "appId"
> {}

/**
 * Runtime binding for `qapps:StopQAppSession`.
 *
 * Stops an active Q App session, halting any in-progress card executions. Provide the implementation with
 * `Effect.provide(AWS.QApps.StopQAppSessionHttp)`.
 * @binding
 * @section Sessions
 * @example Stop a Session
 * ```typescript
 * // init — bind the operation to the Q App
 * const stopQAppSession = yield* AWS.QApps.StopQAppSession(app);
 *
 * // runtime
 * yield* stopQAppSession({ sessionId });
 * ```
 */
export interface StopQAppSession extends Binding.Service<
  StopQAppSession,
  "AWS.QApps.StopQAppSession",
  (
    app: QApp,
  ) => Effect.Effect<
    (
      request: StopQAppSessionRequest,
    ) => Effect.Effect<
      qapps.StopQAppSessionResponse,
      qapps.StopQAppSessionError
    >
  >
> {}

export const StopQAppSession = Binding.Service<StopQAppSession>(
  "AWS.QApps.StopQAppSession",
);
