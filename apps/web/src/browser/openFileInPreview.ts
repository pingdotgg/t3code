import type {
  AssetCreateUrlResult,
  AssetResource,
  EnvironmentId,
  PreviewOpenInput,
  PreviewSessionSnapshot,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  type AtomCommandResult,
  mapAtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import { AsyncResult } from "effect/unstable/reactivity";

import { resolveAssetUrl } from "~/assets/assetUrls";
import {
  applyPreviewServerSnapshot,
  isPreviewSupportedInRuntime,
  rememberPreviewUrl,
} from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";

export const isBrowserPreviewFile = (path: string): boolean =>
  /\.(?:html?|pdf)$/i.test(path.split(/[?#]/, 1)[0] ?? "");

export class BrowserPreviewUnavailableError extends Data.TaggedError(
  "BrowserPreviewUnavailableError",
)<{
  readonly message: string;
}> {}

export type OpenPreviewMutation<E = unknown> = (input: {
  readonly environmentId: EnvironmentId;
  readonly input: PreviewOpenInput;
}) => Promise<AtomCommandResult<PreviewSessionSnapshot, E>>;

export async function openUrlInPreview<E>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly url: string;
  readonly openPreview: OpenPreviewMutation<E>;
}): Promise<AtomCommandResult<void, E>> {
  const result = await input.openPreview({
    environmentId: input.threadRef.environmentId,
    input: { threadId: input.threadRef.threadId, url: input.url },
  });
  return mapAtomCommandResult(result, (snapshot) => {
    applyPreviewServerSnapshot(input.threadRef, snapshot);
    rememberPreviewUrl(input.threadRef, input.url);
    useRightPanelStore.getState().openBrowser(input.threadRef, snapshot.tabId);
  });
}

export async function openFileInPreview<AssetError, PreviewError>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly filePath: string;
  readonly httpBaseUrl: string;
  readonly createAssetUrl: (input: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly resource: AssetResource };
  }) => Promise<AtomCommandResult<AssetCreateUrlResult, AssetError>>;
  readonly openPreview: OpenPreviewMutation<PreviewError>;
}): Promise<AtomCommandResult<void, AssetError | PreviewError | BrowserPreviewUnavailableError>> {
  if (!isPreviewSupportedInRuntime()) {
    return AsyncResult.failure(
      Cause.fail(
        new BrowserPreviewUnavailableError({
          message: "The integrated browser is unavailable in this runtime.",
        }),
      ),
    );
  }
  const assetResult = await input.createAssetUrl({
    environmentId: input.threadRef.environmentId,
    input: {
      resource: {
        _tag: "workspace-file",
        threadId: input.threadRef.threadId,
        path: input.filePath,
      },
    },
  });
  if (assetResult._tag === "Failure") {
    return AsyncResult.failure(assetResult.cause);
  }
  const assetUrl = resolveAssetUrl(input.httpBaseUrl, assetResult.value.relativeUrl);
  if (assetUrl === null) {
    return AsyncResult.failure(
      Cause.die(new Error("The environment returned an invalid asset URL.")),
    );
  }
  return openUrlInPreview({
    threadRef: input.threadRef,
    url: assetUrl,
    openPreview: input.openPreview,
  });
}
