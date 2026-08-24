import type * as qapps from "@distilled.cloud/aws/qapps";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { QApp } from "./QApp.ts";

/**
 * Request for {@link UpdateQAppSessionMetadata} — `instanceId` is injected from the bound Q App.
 */
export interface UpdateQAppSessionMetadataRequest extends Omit<
  qapps.UpdateQAppSessionMetadataInput,
  "instanceId" | "appId"
> {}

/**
 * Runtime binding for `qapps:UpdateQAppSessionMetadata`.
 *
 * Updates a Q App session's metadata — rename it or reconfigure how it is shared with collaborators. Provide the implementation with
 * `Effect.provide(AWS.QApps.UpdateQAppSessionMetadataHttp)`.
 * @binding
 * @section Sessions
 * @example Share a Session
 * ```typescript
 * // init — bind the operation to the Q App
 * const updateQAppSessionMetadata = yield* AWS.QApps.UpdateQAppSessionMetadata(app);
 *
 * // runtime
 * yield* updateQAppSessionMetadata({
 *   sessionId,
 *   sharingConfiguration: { enabled: true, acceptResponses: true },
 * });
 * ```
 */
export interface UpdateQAppSessionMetadata extends Binding.Service<
  UpdateQAppSessionMetadata,
  "AWS.QApps.UpdateQAppSessionMetadata",
  (
    app: QApp,
  ) => Effect.Effect<
    (
      request: UpdateQAppSessionMetadataRequest,
    ) => Effect.Effect<
      qapps.UpdateQAppSessionMetadataOutput,
      qapps.UpdateQAppSessionMetadataError
    >
  >
> {}

export const UpdateQAppSessionMetadata =
  Binding.Service<UpdateQAppSessionMetadata>(
    "AWS.QApps.UpdateQAppSessionMetadata",
  );
