import type {
  AssetCreateUrlResult,
  AssetResource,
  EnvironmentId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { resolveAssetUrl } from "~/assets/assetUrls";
import { toastManager } from "~/components/ui/toast";

export type WorkspaceFileTransferAction = "download" | "copy-file";

export type CreateAssetUrlRunner = (input: {
  readonly environmentId: EnvironmentId;
  readonly input: { readonly resource: AssetResource };
}) => Promise<AtomCommandResult<AssetCreateUrlResult, unknown>>;

export interface WorkspaceFileTransferInput {
  readonly threadRef: ScopedThreadRef;
  readonly filePath: string;
  readonly httpBaseUrl: string;
  readonly createAssetUrl: CreateAssetUrlRunner;
}

export function workspaceFileDownloadName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath;
}

function reportFailure(title: string, cause: unknown): void {
  toastManager.add({
    type: "error",
    title,
    description: cause instanceof Error ? cause.message : "An error occurred.",
  });
}

// Mints a short-lived signed download URL. The server marks it with a
// Content-Disposition attachment header, so it needs no auth header and can
// be handed straight to the browser (works over relay/tunnel connections).
async function createWorkspaceFileDownloadUrl(
  input: WorkspaceFileTransferInput,
): Promise<string | null> {
  const assetResult = await input.createAssetUrl({
    environmentId: input.threadRef.environmentId,
    input: {
      resource: {
        _tag: "workspace-file-download",
        threadId: input.threadRef.threadId,
        path: input.filePath,
      },
    },
  });
  if (assetResult._tag === "Failure") {
    if (!isAtomCommandInterrupted(assetResult)) {
      reportFailure("Unable to prepare download", squashAtomCommandFailure(assetResult));
    }
    return null;
  }
  const assetUrl = resolveAssetUrl(input.httpBaseUrl, assetResult.value.relativeUrl);
  if (assetUrl === null) {
    reportFailure(
      "Unable to prepare download",
      new Error("The environment returned an invalid asset URL."),
    );
  }
  return assetUrl;
}

export async function downloadWorkspaceFile(input: WorkspaceFileTransferInput): Promise<void> {
  const url = await createWorkspaceFileDownloadUrl(input);
  if (url === null) return;
  const anchor = document.createElement("a");
  anchor.href = url;
  // Ignored cross-origin; the server's attachment disposition still forces a
  // download there.
  anchor.download = workspaceFileDownloadName(input.filePath);
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export function canCopyWorkspaceFileToClipboard(): boolean {
  return typeof window !== "undefined" && window.desktopBridge?.copyFileToClipboard !== undefined;
}

export async function copyWorkspaceFileToClipboard(
  input: WorkspaceFileTransferInput,
): Promise<void> {
  const copyFileToClipboard = window.desktopBridge?.copyFileToClipboard;
  if (!copyFileToClipboard) return;
  const url = await createWorkspaceFileDownloadUrl(input);
  if (url === null) return;
  const fileName = workspaceFileDownloadName(input.filePath);
  try {
    await copyFileToClipboard({ url, fileName });
    toastManager.add({
      type: "success",
      title: "File copied",
      description: fileName,
    });
  } catch (cause) {
    reportFailure("Unable to copy file", cause);
  }
}
