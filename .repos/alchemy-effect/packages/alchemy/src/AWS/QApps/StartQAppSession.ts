import type * as qapps from "@distilled.cloud/aws/qapps";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { QApp } from "./QApp.ts";

/**
 * Request for {@link StartQAppSession} — `instanceId` and `appId` are injected from the bound Q App.
 */
export interface StartQAppSessionRequest extends Omit<
  qapps.StartQAppSessionInput,
  "instanceId" | "appId"
> {}

/**
 * Runtime binding for `qapps:StartQAppSession`.
 *
 * Starts a new session of the bound Q App, optionally seeding initial card values. Provide the implementation with
 * `Effect.provide(AWS.QApps.StartQAppSessionHttp)`.
 * @binding
 * @section Sessions
 * @example Start a Session
 * ```typescript
 * // init — bind the operation to the Q App
 * const startQAppSession = yield* AWS.QApps.StartQAppSession(app);
 *
 * // runtime
 * const session = yield* startQAppSession({ appVersion: 1 });
 * console.log(session.sessionId);
 * ```
 */
export interface StartQAppSession extends Binding.Service<
  StartQAppSession,
  "AWS.QApps.StartQAppSession",
  (
    app: QApp,
  ) => Effect.Effect<
    (
      request: StartQAppSessionRequest,
    ) => Effect.Effect<
      qapps.StartQAppSessionOutput,
      qapps.StartQAppSessionError
    >
  >
> {}

export const StartQAppSession = Binding.Service<StartQAppSession>(
  "AWS.QApps.StartQAppSession",
);
