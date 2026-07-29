import {
  mapAtomCommandResult,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { isPreviewSupportedInRuntime } from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";

import {
  openPreviewSession,
  type OpenPreviewMutation,
} from "~/components/preview/openPreviewSession";

export const isBrowserPreviewFile = (path: string): boolean =>
  /\.(?:html?|pdf)$/i.test(path.split(/[?#]/, 1)[0] ?? "");

export async function openFileInPreview<E>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly relativePath: string;
  readonly httpBaseUrl: string;
  readonly createAssetUrl: (input: {
    readonly resource: {
      readonly _tag: "workspace-file";
      readonly threadId: ScopedThreadRef["threadId"];
      readonly path: string;
    };
  }) => Promise<{ readonly relativeUrl: string }>;
  readonly openPreview: OpenPreviewMutation<E>;
}): Promise<AtomCommandResult<void, E>> {
  if (!isPreviewSupportedInRuntime()) {
    throw new Error("The integrated browser is unavailable in this runtime.");
  }
  const asset = await input.createAssetUrl({
    resource: {
      _tag: "workspace-file",
      threadId: input.threadRef.threadId,
      path: input.relativePath,
    },
  });
  let url: string;
  try {
    url = new URL(asset.relativeUrl, input.httpBaseUrl).toString();
  } catch {
    throw new Error("The environment returned an invalid asset URL.");
  }
  const result = await openPreviewSession({
    openPreview: input.openPreview,
    threadRef: input.threadRef,
    url,
  });
  return mapAtomCommandResult(result, (snapshot) => {
    useRightPanelStore.getState().openBrowser(input.threadRef, snapshot.tabId);
  });
}
