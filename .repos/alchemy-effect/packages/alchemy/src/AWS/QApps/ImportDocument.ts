import type * as qapps from "@distilled.cloud/aws/qapps";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { QApp } from "./QApp.ts";

/**
 * Request for {@link ImportDocument} — `instanceId` and `appId` are injected from the bound Q App.
 */
export interface ImportDocumentRequest extends Omit<
  qapps.ImportDocumentInput,
  "instanceId" | "appId"
> {}

/**
 * Runtime binding for `qapps:ImportDocument`.
 *
 * Uploads a base64-encoded file into a card of the bound Q App, at app or session scope. Provide the implementation with
 * `Effect.provide(AWS.QApps.ImportDocumentHttp)`.
 * @binding
 * @section Files
 * @example Import a Document
 * ```typescript
 * // init — bind the operation to the Q App
 * const importDocument = yield* AWS.QApps.ImportDocument(app);
 *
 * // runtime
 * const imported = yield* importDocument({
 *   cardId,
 *   fileContentsBase64,
 *   fileName: "notes.txt",
 *   scope: "SESSION",
 *   sessionId,
 * });
 * console.log(imported.fileId);
 * ```
 */
export interface ImportDocument extends Binding.Service<
  ImportDocument,
  "AWS.QApps.ImportDocument",
  (
    app: QApp,
  ) => Effect.Effect<
    (
      request: ImportDocumentRequest,
    ) => Effect.Effect<qapps.ImportDocumentOutput, qapps.ImportDocumentError>
  >
> {}

export const ImportDocument = Binding.Service<ImportDocument>(
  "AWS.QApps.ImportDocument",
);
