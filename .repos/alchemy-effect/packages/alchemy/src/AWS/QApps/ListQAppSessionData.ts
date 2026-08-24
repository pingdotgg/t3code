import type * as qapps from "@distilled.cloud/aws/qapps";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { QApp } from "./QApp.ts";

/**
 * Request for {@link ListQAppSessionData} — `instanceId` is injected from the bound Q App.
 */
export interface ListQAppSessionDataRequest extends Omit<
  qapps.ListQAppSessionDataInput,
  "instanceId" | "appId"
> {}

/**
 * Runtime binding for `qapps:ListQAppSessionData`.
 *
 * Lists the per-user data collected in a shared Q App session. Provide the implementation with
 * `Effect.provide(AWS.QApps.ListQAppSessionDataHttp)`.
 * @binding
 * @section Sessions
 * @example List Session Data
 * ```typescript
 * // init — bind the operation to the Q App
 * const listQAppSessionData = yield* AWS.QApps.ListQAppSessionData(app);
 *
 * // runtime
 * const data = yield* listQAppSessionData({ sessionId });
 * console.log(data.sessionData?.length);
 * ```
 */
export interface ListQAppSessionData extends Binding.Service<
  ListQAppSessionData,
  "AWS.QApps.ListQAppSessionData",
  (
    app: QApp,
  ) => Effect.Effect<
    (
      request: ListQAppSessionDataRequest,
    ) => Effect.Effect<
      qapps.ListQAppSessionDataOutput,
      qapps.ListQAppSessionDataError
    >
  >
> {}

export const ListQAppSessionData = Binding.Service<ListQAppSessionData>(
  "AWS.QApps.ListQAppSessionData",
);
