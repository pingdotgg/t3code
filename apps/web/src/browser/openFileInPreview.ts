import type {
  AssetCreateUrlResult,
  AssetResource,
  EnvironmentId,
  PreviewOpenInput,
  PreviewSessionSnapshot,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  type AtomCommandResult,
  mapAtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  isWorkspaceBrowserPreviewPath,
  isWorkspaceImagePreviewPath,
  isWorkspacePreviewEntryPath,
} from "@t3tools/shared/filePreview";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/unstable/reactivity";

import {
  applyPreviewServerSnapshot,
  isPreviewSupportedInRuntime,
  rememberPreviewUrl,
} from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";

export const isBrowserPreviewFile = isWorkspaceBrowserPreviewPath;
export const isImagePreviewFile = isWorkspaceImagePreviewPath;
export const isWorkspacePreviewFile = isWorkspacePreviewEntryPath;

export class BrowserPreviewUnavailableError extends Schema.TaggedErrorClass<BrowserPreviewUnavailableError>()(
  "BrowserPreviewUnavailableError",
  {
    environmentId: Schema.String,
    threadId: Schema.String,
  },
) {
  override get message(): string {
    return "The integrated browser is unavailable in this runtime.";
  }
}

export class BrowserPreviewThreadContextUnavailableError extends Schema.TaggedErrorClass<BrowserPreviewThreadContextUnavailableError>()(
  "BrowserPreviewThreadContextUnavailableError",
  {},
) {
  override get message(): string {
    return "Thread context is unavailable.";
  }
}

export class BrowserPreviewEnvironmentDisconnectedError extends Schema.TaggedErrorClass<BrowserPreviewEnvironmentDisconnectedError>()(
  "BrowserPreviewEnvironmentDisconnectedError",
  {
    environmentId: Schema.String,
    threadId: Schema.String,
  },
) {
  override get message(): string {
    return "Environment is not connected.";
  }
}

export class BrowserPreviewAssetUrlInvalidError extends Schema.TaggedErrorClass<BrowserPreviewAssetUrlInvalidError>()(
  "BrowserPreviewAssetUrlInvalidError",
  {
    environmentId: Schema.String,
    threadId: Schema.String,
    filePath: Schema.String,
    httpBaseUrlLength: Schema.Int,
    relativeUrlLength: Schema.Int,
    expiresAt: Schema.Int,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "The environment returned an invalid asset URL.";
  }
}

export const isBrowserPreviewAssetUrlInvalidError = Schema.is(BrowserPreviewAssetUrlInvalidError);

export type OpenPreviewMutation<E = unknown> = (input: {
  readonly environmentId: EnvironmentId;
  readonly input: PreviewOpenInput;
}) => Promise<AtomCommandResult<PreviewSessionSnapshot, E>>;

interface PreviewRequest {
  readonly isCurrent: () => boolean;
  readonly complete: () => void;
}

const activePreviewRequestByThread = new Map<string, symbol>();

const beginPreviewRequest = (
  threadRef: ScopedThreadRef,
  signal: AbortSignal | undefined,
): PreviewRequest => {
  const threadKey = scopedThreadKey(threadRef);
  const requestId = Symbol();
  activePreviewRequestByThread.set(threadKey, requestId);
  return {
    isCurrent: () =>
      activePreviewRequestByThread.get(threadKey) === requestId && signal?.aborted !== true,
    complete: () => {
      if (activePreviewRequestByThread.get(threadKey) === requestId) {
        activePreviewRequestByThread.delete(threadKey);
      }
    },
  };
};

const openUrlForPreviewRequest = async <E>(
  input: {
    readonly threadRef: ScopedThreadRef;
    readonly url: string;
    readonly openPreview: OpenPreviewMutation<E>;
  },
  request: PreviewRequest,
): Promise<AtomCommandResult<void, E>> => {
  const result = await input.openPreview({
    environmentId: input.threadRef.environmentId,
    input: { threadId: input.threadRef.threadId, url: input.url },
  });
  if (!request.isCurrent()) {
    return AsyncResult.success(undefined);
  }
  return mapAtomCommandResult(result, (snapshot) => {
    applyPreviewServerSnapshot(input.threadRef, snapshot);
    rememberPreviewUrl(input.threadRef, input.url);
    useRightPanelStore.getState().openBrowser(input.threadRef, snapshot.tabId);
  });
};

export async function openUrlInPreview<E>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly url: string;
  readonly openPreview: OpenPreviewMutation<E>;
  readonly signal?: AbortSignal;
}): Promise<AtomCommandResult<void, E>> {
  const request = beginPreviewRequest(input.threadRef, input.signal);
  try {
    return await openUrlForPreviewRequest(input, request);
  } finally {
    request.complete();
  }
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
  readonly signal?: AbortSignal;
}): Promise<
  AtomCommandResult<
    void,
    AssetError | PreviewError | BrowserPreviewUnavailableError | BrowserPreviewAssetUrlInvalidError
  >
> {
  const request = beginPreviewRequest(input.threadRef, input.signal);
  try {
    if (!isPreviewSupportedInRuntime()) {
      return AsyncResult.failure(
        Cause.fail(
          new BrowserPreviewUnavailableError({
            environmentId: input.threadRef.environmentId,
            threadId: input.threadRef.threadId,
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
    if (!request.isCurrent()) {
      return AsyncResult.success(undefined);
    }
    if (assetResult._tag === "Failure") {
      return AsyncResult.failure(assetResult.cause);
    }
    let assetUrl: string;
    try {
      assetUrl = new URL(assetResult.value.relativeUrl, input.httpBaseUrl).toString();
    } catch (cause) {
      return AsyncResult.failure(
        Cause.fail(
          new BrowserPreviewAssetUrlInvalidError({
            environmentId: input.threadRef.environmentId,
            threadId: input.threadRef.threadId,
            filePath: input.filePath,
            httpBaseUrlLength: input.httpBaseUrl.length,
            relativeUrlLength: assetResult.value.relativeUrl.length,
            expiresAt: assetResult.value.expiresAt,
            cause,
          }),
        ),
      );
    }
    return await openUrlForPreviewRequest(
      {
        threadRef: input.threadRef,
        url: assetUrl,
        openPreview: input.openPreview,
      },
      request,
    );
  } finally {
    request.complete();
  }
}
