import type * as qapps from "@distilled.cloud/aws/qapps";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { QApp } from "./QApp.ts";

/**
 * Request for {@link GetQAppSessionMetadata} — `instanceId` is injected from the bound Q App.
 */
export interface GetQAppSessionMetadataRequest extends Omit<
  qapps.GetQAppSessionMetadataInput,
  "instanceId" | "appId"
> {}

/**
 * Runtime binding for `qapps:GetQAppSessionMetadata`.
 *
 * Retrieves a Q App session's metadata — name, sharing configuration, and ownership. Provide the implementation with
 * `Effect.provide(AWS.QApps.GetQAppSessionMetadataHttp)`.
 * @binding
 * @section Sessions
 * @example Read Session Sharing Configuration
 * ```typescript
 * // init — bind the operation to the Q App
 * const getQAppSessionMetadata = yield* AWS.QApps.GetQAppSessionMetadata(app);
 *
 * // runtime
 * const metadata = yield* getQAppSessionMetadata({ sessionId });
 * console.log(metadata.sharingConfiguration.enabled);
 * ```
 */
export interface GetQAppSessionMetadata extends Binding.Service<
  GetQAppSessionMetadata,
  "AWS.QApps.GetQAppSessionMetadata",
  (
    app: QApp,
  ) => Effect.Effect<
    (
      request: GetQAppSessionMetadataRequest,
    ) => Effect.Effect<
      qapps.GetQAppSessionMetadataOutput,
      qapps.GetQAppSessionMetadataError
    >
  >
> {}

export const GetQAppSessionMetadata = Binding.Service<GetQAppSessionMetadata>(
  "AWS.QApps.GetQAppSessionMetadata",
);
