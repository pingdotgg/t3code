import type * as qapps from "@distilled.cloud/aws/qapps";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { QApp } from "./QApp.ts";

/**
 * Request for {@link GetQAppSession} — `instanceId` is injected from the bound Q App.
 */
export interface GetQAppSessionRequest extends Omit<
  qapps.GetQAppSessionInput,
  "instanceId" | "appId"
> {}

/**
 * Runtime binding for `qapps:GetQAppSession`.
 *
 * Retrieves the current state of a Q App session — execution status plus the per-card status map. Provide the implementation with
 * `Effect.provide(AWS.QApps.GetQAppSessionHttp)`.
 * @binding
 * @section Sessions
 * @example Poll a Session Until It Completes
 * ```typescript
 * // init — bind the operation to the Q App
 * const getQAppSession = yield* AWS.QApps.GetQAppSession(app);
 *
 * // runtime
 * const state = yield* getQAppSession({ sessionId });
 * if (state.status === "COMPLETED") console.log(state.cardStatus);
 * ```
 */
export interface GetQAppSession extends Binding.Service<
  GetQAppSession,
  "AWS.QApps.GetQAppSession",
  (
    app: QApp,
  ) => Effect.Effect<
    (
      request: GetQAppSessionRequest,
    ) => Effect.Effect<qapps.GetQAppSessionOutput, qapps.GetQAppSessionError>
  >
> {}

export const GetQAppSession = Binding.Service<GetQAppSession>(
  "AWS.QApps.GetQAppSession",
);
