import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import {
  createAttachmentEnvironmentAtoms,
  runAttachmentUploadCycle,
} from "@t3tools/client-runtime/state/attachments";
import { attachmentUploadError } from "@t3tools/client-runtime/state/attachment-uploads";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import type {
  AttachmentCreateUploadUrlInput,
  ChatAttachment,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { AtomRegistry } from "effect/reactivity";

import { attachmentInputs, sentAttachment } from "../chat/attachments";
import { connectionAtomRuntime } from "../connection/runtime";
import { messageOrchestrator } from "../foryou/actions";
import { environmentSession } from "./server";

const attachmentEnvironment = createAttachmentEnvironmentAtoms(connectionAtomRuntime);

const UPLOAD_FAILED = "Upload failed";

async function postBytes(url: string, file: File, mimeType: string, signal: AbortSignal) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": mimeType },
    body: file,
    signal,
  });
  if (!response.ok) throw new Error(`Upload rejected (${response.status})`);
}

/**
 * Uploads each file to T3 as the request at the same index describes it. Resolves to the
 * attachments a message sends, or throws the first failure.
 */
export async function uploadAttachments(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  files: ReadonlyArray<File>,
  inputs: ReadonlyArray<AttachmentCreateUploadUrlInput>,
): Promise<ChatAttachment[]> {
  const connection = Option.getOrNull(
    registry.get(environmentSession.preparedConnectionValueAtom(environmentId)),
  );
  const attachments: ChatAttachment[] = [];
  for (const [index, upload] of inputs.entries()) {
    const file = files[index]!;
    const result = await Effect.runPromise(
      runAttachmentUploadCycle({
        registry,
        createUploadUrl: attachmentEnvironment.createUploadUrl,
        remove: attachmentEnvironment.remove,
        environmentId,
        upload,
        resolveUploadUrl: (relativeUrl) =>
          connection === null ? null : resolveAssetUrl(connection.httpBaseUrl, relativeUrl),
        transport: (url) =>
          Effect.tryPromise({
            try: (signal) => postBytes(url, file, upload.mimeType, signal),
            catch: attachmentUploadError,
          }),
      }),
    );
    if (result.status !== "uploaded") {
      throw new Error(errorDisplayMessage(result.error) ?? UPLOAD_FAILED);
    }
    attachments.push(sentAttachment(upload, result.attachmentId));
  }
  return attachments;
}

/** Sends the files to a board's orchestrator as its docs. Resolves to the failure text, or null once sent. */
export async function addDocs(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  orchestratorThreadId: string | null,
  files: ReadonlyArray<File>,
): Promise<string | null> {
  const checked = attachmentInputs(files);
  if ("error" in checked) return checked.error;
  try {
    const attachments = await uploadAttachments(registry, environmentId, files, checked.inputs);
    return await messageOrchestrator(
      registry,
      environmentId,
      orchestratorThreadId,
      async () => "Add these docs to the board's work",
      undefined,
      attachments,
    );
  } catch (failure) {
    return failure instanceof Error ? failure.message : String(failure);
  }
}
