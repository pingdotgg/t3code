import type {
  AssetCreateUrlResult,
  AssetResource,
  EnvironmentId,
  PreviewOpenInput,
  PreviewSessionSnapshot,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { mediaFileReference } from "@t3tools/client-runtime/media-reference";
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

import {
  browserDefaultOpenProfileId,
  browserDefaultOpenViewport,
  resolveBrowserDefaults,
} from "./browserDefaults";

export const isBrowserPreviewFile = (path: string): boolean =>
  /\.(?:html?|pdf)$/i.test(path.split(/[?#]/, 1)[0] ?? "");

export class BrowserPreviewUnavailableError extends Data.TaggedError(
  "BrowserPreviewUnavailableError",
)<{
  readonly message: string;
}> {}

export class BrowserSettingsReadError extends Data.TaggedError("BrowserSettingsReadError")<{
  readonly cause: unknown;
}> {
  override get message(): string {
    return "Saved browser settings could not be loaded.";
  }
}

export type OpenPreviewMutation<E = unknown> = (input: {
  readonly environmentId: EnvironmentId;
  readonly input: PreviewOpenInput;
}) => Promise<AtomCommandResult<PreviewSessionSnapshot, E>>;

export interface ExternalFileOpenSession {
  readonly open: (url: string) => Promise<void>;
  readonly cancel: () => void;
}

export function beginExternalFileOpen(input: {
  readonly isDesktop: boolean;
  readonly openExternal: (url: string) => Promise<void>;
  readonly openWindow: () => Pick<Window, "close" | "location" | "opener"> | null;
}): ExternalFileOpenSession {
  if (input.isDesktop) {
    return { open: input.openExternal, cancel: () => undefined };
  }
  const tab = input.openWindow();
  if (!tab) throw new Error("The browser blocked the new tab.");
  tab.opener = null;
  return {
    open: async (url) => tab.location.replace(url),
    cancel: () => tab.close(),
  };
}

export async function openUrlInPreview<E>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly url: string;
  readonly openPreview: OpenPreviewMutation<E>;
}): Promise<AtomCommandResult<void, E | BrowserSettingsReadError>> {
  const defaults = await resolveBrowserDefaults().catch(
    (cause: unknown) => new BrowserSettingsReadError({ cause }),
  );
  if (defaults instanceof BrowserSettingsReadError) {
    return AsyncResult.failure(Cause.fail(defaults));
  }
  const result = await input.openPreview({
    environmentId: input.threadRef.environmentId,
    input: {
      threadId: input.threadRef.threadId,
      url: input.url,
      // Built here rather than via `openPreviewSession` because this path
      // maps the result differently, so the configured defaults have to be
      // applied explicitly or file/link opens would ignore them.
      viewport: browserDefaultOpenViewport(defaults),
      profileId: browserDefaultOpenProfileId(defaults),
    },
  });
  return mapAtomCommandResult(result, (snapshot) => {
    applyPreviewServerSnapshot(input.threadRef, snapshot);
    rememberPreviewUrl(input.threadRef, input.url);
    useRightPanelStore.getState().openBrowser(input.threadRef, snapshot.tabId);
  });
}

type CreateAssetUrl<E> = (input: {
  readonly environmentId: EnvironmentId;
  readonly input: { readonly resource: AssetResource };
}) => Promise<AtomCommandResult<AssetCreateUrlResult, E>>;

/**
 * Signs a file for the browser. Inside the workspace the page may load sibling
 * assets; a file outside it is served on its own.
 */
async function createFileAssetUrl<E>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly filePath: string;
  readonly workspaceRoot: string | undefined;
  readonly httpBaseUrl: string;
  readonly createAssetUrl: CreateAssetUrl<E>;
}): Promise<AtomCommandResult<string, E>> {
  const insideWorkspace =
    mediaFileReference(input.filePath, input.workspaceRoot).relativePath !== undefined;
  const assetResult = await input.createAssetUrl({
    environmentId: input.threadRef.environmentId,
    input: {
      resource: {
        _tag: insideWorkspace ? "workspace-file" : "media-file",
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
  return AsyncResult.success(assetUrl);
}

/** Opens a browser document in the integrated browser. */
export async function openFileInPreview<AssetError, PreviewError>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly filePath: string;
  readonly workspaceRoot: string | undefined;
  readonly httpBaseUrl: string;
  readonly createAssetUrl: CreateAssetUrl<AssetError>;
  readonly openPreview: OpenPreviewMutation<PreviewError>;
}): Promise<
  AtomCommandResult<
    void,
    AssetError | PreviewError | BrowserPreviewUnavailableError | BrowserSettingsReadError
  >
> {
  if (!isPreviewSupportedInRuntime()) {
    return AsyncResult.failure(
      Cause.fail(
        new BrowserPreviewUnavailableError({
          message: "The integrated browser is unavailable in this runtime.",
        }),
      ),
    );
  }
  const assetUrl = await createFileAssetUrl(input);
  if (assetUrl._tag === "Failure") {
    return AsyncResult.failure(assetUrl.cause);
  }
  return openUrlInPreview({
    threadRef: input.threadRef,
    url: assetUrl.value,
    openPreview: input.openPreview,
  });
}

/** Opens a browser document in a new system browser tab (web) or the default browser (desktop). */
export async function openFileInExternalBrowser<AssetError>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly filePath: string;
  readonly workspaceRoot: string | undefined;
  readonly httpBaseUrl: string;
  readonly createAssetUrl: CreateAssetUrl<AssetError>;
  /** Runs before the first await so a web click can reserve its tab synchronously. */
  readonly beginOpen: () => ExternalFileOpenSession;
}): Promise<AtomCommandResult<void, AssetError>> {
  const session = input.beginOpen();
  try {
    const assetUrl = await createFileAssetUrl(input);
    if (assetUrl._tag === "Failure") {
      session.cancel();
      return AsyncResult.failure(assetUrl.cause);
    }
    await session.open(assetUrl.value);
    return AsyncResult.success(undefined);
  } catch (cause) {
    session.cancel();
    throw cause;
  }
}
