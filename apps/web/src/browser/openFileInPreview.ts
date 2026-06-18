import type { ScopedThreadRef } from "@t3tools/contracts";

import { readEnvironmentApi } from "~/environmentApi";
import { resolveAssetUrl } from "~/assets/assetUrls";
import { usePanelLayoutStore } from "~/panelLayoutStore";
import { isPreviewSupportedInRuntime, usePreviewStateStore } from "~/previewStateStore";

export const isBrowserPreviewFile = (path: string): boolean =>
  /\.(?:html?|pdf)$/i.test(path.split(/[?#]/, 1)[0] ?? "");

export async function openUrlInPreview(threadRef: ScopedThreadRef, url: string): Promise<void> {
  const api = readEnvironmentApi(threadRef.environmentId);
  if (!api) {
    throw new Error("Environment is not connected.");
  }

  const snapshot = await api.preview.open({ threadId: threadRef.threadId, url });
  usePreviewStateStore.getState().applyServerSnapshot(threadRef, snapshot);
  usePreviewStateStore.getState().rememberUrl(threadRef, url);
  usePanelLayoutStore.getState().addTab(threadRef, "right", { kind: "browser" });
}

export async function openFileInPreview(
  threadRef: ScopedThreadRef,
  filePath: string,
): Promise<void> {
  if (!isPreviewSupportedInRuntime()) {
    throw new Error("The integrated browser is unavailable in this runtime.");
  }
  const asset = await resolveAssetUrl(threadRef.environmentId, {
    _tag: "workspace-file",
    threadId: threadRef.threadId,
    path: filePath,
  });
  await openUrlInPreview(threadRef, asset.url);
}
