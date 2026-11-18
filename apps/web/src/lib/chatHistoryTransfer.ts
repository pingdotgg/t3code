import type {
  ChatHistoryExportScope,
  ChatHistoryImportResult,
  EnvironmentId,
} from "@t3tools/contracts";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { attachmentUploadError } from "@t3tools/client-runtime/state/attachment-uploads";
import { runAttachmentUploadCycle } from "@t3tools/client-runtime/state/attachments";
import {
  runAtomCommand,
  squashAtomCommandFailure,
  type AtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import { msg } from "gt-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";

import { toastManager } from "../components/ui/toast";

import { m } from "../i18n/messages";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { attachmentEnvironment } from "../state/attachments";
import { chatHistoryEnvironment } from "../state/chatHistory";
import { readPreparedConnection } from "../state/session";
import { uploadBytes } from "./attachmentUploadQueue";

const GZIP_MIME_TYPE = "application/gzip";

async function run<W, A, E>(command: AtomCommand<W, A, E>, input: W): Promise<A> {
  const result = await runAtomCommand(appAtomRegistry, command, input, { reportFailure: false });
  if (result._tag === "Success") return result.value;
  throw squashAtomCommandFailure(result);
}

function serverUrl(environmentId: EnvironmentId, relativeUrl: string): string | null {
  const connection = readPreparedConnection(environmentId);
  return connection ? resolveAssetUrl(connection.httpBaseUrl, relativeUrl) : null;
}

const disconnected = () => new Error(m(msg("Reconnect to the environment and try again.")));

/** Writes the chats in `scope` to one file and saves it. Resolves to how many it holds. */
async function exportChatHistory(
  environmentId: EnvironmentId,
  scope: ChatHistoryExportScope,
): Promise<number> {
  const exported = await run(chatHistoryEnvironment.export, { environmentId, input: { scope } });
  const target = await run(chatHistoryEnvironment.downloadUrl, {
    environmentId,
    input: {
      resource: {
        _tag: "attachment",
        attachmentId: exported.attachmentId,
        fileName: exported.fileName,
        mimeType: GZIP_MIME_TYPE,
        disposition: "attachment",
      },
    },
  });
  const url = serverUrl(environmentId, target.relativeUrl);
  if (url === null) throw disconnected();
  const response = await fetch(url);
  if (!response.ok) throw new Error(m(msg("The file could not be loaded. Try again.")));
  // Blob downloads keep desktop's custom app scheme from navigating to an external browser.
  const downloadUrl = URL.createObjectURL(await response.blob());
  setTimeout(() => URL.revokeObjectURL(downloadUrl), 30_000);
  const anchor = document.createElement("a");
  anchor.href = downloadUrl;
  anchor.download = exported.fileName;
  anchor.click();
  return exported.threadCount;
}

/** Uploads an exported file and adds the chats this environment does not have yet. */
export async function importChatHistory(
  environmentId: EnvironmentId,
  file: File,
): Promise<ChatHistoryImportResult> {
  const uploaded = await Effect.runPromise(
    runAttachmentUploadCycle({
      registry: appAtomRegistry,
      createUploadUrl: attachmentEnvironment.createUploadUrl,
      remove: attachmentEnvironment.remove,
      environmentId,
      upload: { type: "file", name: file.name, mimeType: GZIP_MIME_TYPE, sizeBytes: file.size },
      resolveUploadUrl: (relativeUrl) => serverUrl(environmentId, relativeUrl),
      transport: (url) =>
        Effect.tryPromise({
          try: (signal) =>
            uploadBytes({ url, file, mimeType: GZIP_MIME_TYPE, signal, onProgress: () => {} }),
          catch: attachmentUploadError,
        }),
    }),
  );
  if (uploaded.status === "failed") {
    if (uploaded.step === "resolve-url") throw disconnected();
    throw uploaded.error instanceof Error
      ? uploaded.error
      : new Error(m(msg("The file could not be uploaded.")));
  }
  return run(chatHistoryEnvironment.import, {
    environmentId,
    input: { attachmentId: uploaded.attachmentId },
  });
}

/** Exports from a menu or button, reporting the outcome as a toast. */
export function exportChatHistoryWithToast(
  environmentId: EnvironmentId,
  scope: ChatHistoryExportScope,
): Promise<void> {
  return exportChatHistory(environmentId, scope).then(
    (count) => {
      toastManager.add({
        type: "success",
        title: m(
          msg("{count, plural, one {Exported # thread} other {Exported # threads}}", { count }),
        ),
      });
    },
    (cause: unknown) => {
      toastManager.add({
        type: "error",
        title: m(msg("Could not export threads")),
        description: thrownErrorMessage(cause, m) ?? m(msg("Please try again.")),
      });
    },
  );
}
