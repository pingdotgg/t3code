import type * as qapps from "@distilled.cloud/aws/qapps";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { QApp } from "./QApp.ts";

/**
 * Request for {@link CreatePresignedUrl} — `instanceId` and `appId` are injected from the bound Q App.
 */
export interface CreatePresignedUrlRequest extends Omit<
  qapps.CreatePresignedUrlInput,
  "instanceId" | "appId"
> {}

/**
 * Runtime binding for `qapps:CreatePresignedUrl`.
 *
 * Creates a presigned upload URL for a file-upload card of the bound Q App. Provide the implementation with
 * `Effect.provide(AWS.QApps.CreatePresignedUrlHttp)`.
 * @binding
 * @section Files
 * @example Create a Presigned Upload URL
 * ```typescript
 * // init — bind the operation to the Q App
 * const createPresignedUrl = yield* AWS.QApps.CreatePresignedUrl(app);
 *
 * // runtime
 * const upload = yield* createPresignedUrl({
 *   cardId,
 *   fileContentsSha256,
 *   fileName: "report.pdf",
 *   scope: "SESSION",
 *   sessionId,
 * });
 * console.log(upload.presignedUrl);
 * ```
 */
export interface CreatePresignedUrl extends Binding.Service<
  CreatePresignedUrl,
  "AWS.QApps.CreatePresignedUrl",
  (
    app: QApp,
  ) => Effect.Effect<
    (
      request: CreatePresignedUrlRequest,
    ) => Effect.Effect<
      qapps.CreatePresignedUrlOutput,
      qapps.CreatePresignedUrlError
    >
  >
> {}

export const CreatePresignedUrl = Binding.Service<CreatePresignedUrl>(
  "AWS.QApps.CreatePresignedUrl",
);
