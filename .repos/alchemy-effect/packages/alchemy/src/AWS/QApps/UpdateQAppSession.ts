import type * as qapps from "@distilled.cloud/aws/qapps";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { QApp } from "./QApp.ts";

/**
 * Request for {@link UpdateQAppSession} — `instanceId` is injected from the bound Q App.
 */
export interface UpdateQAppSessionRequest extends Omit<
  qapps.UpdateQAppSessionInput,
  "instanceId" | "appId"
> {}

/**
 * Runtime binding for `qapps:UpdateQAppSession`.
 *
 * Submits new card values into a running Q App session (e.g. answers a text-input card). Provide the implementation with
 * `Effect.provide(AWS.QApps.UpdateQAppSessionHttp)`.
 * @binding
 * @section Sessions
 * @example Submit Card Values
 * ```typescript
 * // init — bind the operation to the Q App
 * const updateQAppSession = yield* AWS.QApps.UpdateQAppSession(app);
 *
 * // runtime
 * yield* updateQAppSession({
 *   sessionId,
 *   values: [{ cardId, value: "Hello, Q Apps!" }],
 * });
 * ```
 */
export interface UpdateQAppSession extends Binding.Service<
  UpdateQAppSession,
  "AWS.QApps.UpdateQAppSession",
  (
    app: QApp,
  ) => Effect.Effect<
    (
      request: UpdateQAppSessionRequest,
    ) => Effect.Effect<
      qapps.UpdateQAppSessionOutput,
      qapps.UpdateQAppSessionError
    >
  >
> {}

export const UpdateQAppSession = Binding.Service<UpdateQAppSession>(
  "AWS.QApps.UpdateQAppSession",
);
