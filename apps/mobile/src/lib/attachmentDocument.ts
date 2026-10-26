import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Atom, AsyncResult } from "effect/reactivity";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Dialog from "../components/ui/Dialog";
import { filePreviewDelimiter, parseDelimitedPreview } from "@t3tools/shared/delimitedPreview";
import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import { readFilePreviewResponse } from "@t3tools/client-runtime/file-preview";
import { filePreviewKind, FILE_TEXT_PREVIEW_MAX_BYTES } from "@t3tools/shared/filePreview";
import { fetch } from "expo/fetch";
import { File } from "expo-file-system";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { useEffect, useRef, useState } from "react";

import type { FileBackedComposerAttachment } from "./composerImages";
import { localAttachmentPreviewAtom, localAttachmentPreviewState } from "./localAttachmentPreview";
import { downloadAndShareAttachment, shareLocalAttachment } from "./attachmentDownload";
import { refreshAssetUrl, useFreshAssetUrl, useRefreshAssetUrl } from "../state/assets";
import { attachmentDocumentPresentation } from "./attachmentDocumentPresentation";

const isLocalUri = (uri: string) => /^(file|content):/.test(uri);

/** Signed asset URLs live for an hour; treat anything older than this as worth re-minting. */
const STALE_URL_MS = 5 * 60_000;

interface AttachmentTextKey {
  readonly uri: string;
  /** When a remote `uri` was signed; null for local files. */
  readonly authorizedAt: number | null;
  readonly environmentId: EnvironmentId | null;
  readonly resource: AssetResource;
  readonly sizeBytes: number;
  readonly revision: number;
}

async function readAttachmentText(key: AttachmentTextKey, signal: AbortSignal) {
  if (isLocalUri(key.uri)) {
    return readFilePreviewResponse({ ok: true, body: new File(key.uri).readableStream() }, signal);
  }
  // Reauthorize before source reads; the opening URL may have expired.
  let target = key.uri;
  if (key.authorizedAt === null || Date.now() - key.authorizedAt > STALE_URL_MS) {
    const refreshed =
      key.environmentId === null
        ? null
        : await refreshAssetUrl(key.environmentId, key.resource, signal);
    if (!refreshed) throw new Error("Reconnect to this environment and try again.");
    target = refreshed;
  }
  const response = await fetch(target, {
    signal,
    headers: {
      ...(key.sizeBytes > 0 ? { Range: `bytes=0-${FILE_TEXT_PREVIEW_MAX_BYTES}` } : {}),
      ...(key.revision > 0 ? { "Cache-Control": "no-cache" } : {}),
    },
  });
  return readFilePreviewResponse(response, signal);
}

// Plain-object keys compare structurally (Effect `Equal`/`Hash`). Unmounting the
// last reader interrupts the read, which aborts the fetch.
const attachmentTextAtom = Atom.family((key: AttachmentTextKey) =>
  Atom.make(
    Effect.tryPromise({
      try: (signal) => readAttachmentText(key, signal),
      catch: (cause) => (cause instanceof Error ? cause : new Error("Could not read this file.")),
    }),
  ).pipe(Atom.withLabel("attachment-text")),
);

const noAttachmentText = Atom.make(
  AsyncResult.initial<{ text: string; truncated: boolean }, Error>(),
).pipe(Atom.withLabel("attachment-text:none"));

/** Captured bytes never resolve against the workspace. */
export function useAttachmentDocument(input: {
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly attachmentId: string;
  readonly environmentId: EnvironmentId | null;
  readonly attachment: FileBackedComposerAttachment | null;
}) {
  const kind = filePreviewKind(input, { richDocuments: false });
  const delimiter = filePreviewDelimiter(input);
  const shareController = useRef<AbortController | null>(null);
  useEffect(() => () => shareController.current?.abort(), []);
  const resource = {
    _tag: "attachment" as const,
    attachmentId: input.attachmentId,
    fileName: input.name,
    mimeType: input.mimeType,
    disposition: "inline" as const,
  };
  const environmentId = input.attachment ? null : input.environmentId;
  const refresh = useRefreshAssetUrl(environmentId, resource);
  const [rendered, setRendered] = useState(true);
  const [revision, setRevision] = useState(0);
  const [sharing, setSharing] = useState(false);
  const attachment = input.attachment;
  const localPreviewAtom = localAttachmentPreviewAtom(attachment);
  const localPreview = localAttachmentPreviewState(useAtomValue(localPreviewAtom));
  const refreshLocalPreview = useAtomRefresh(localPreviewAtom);
  const remote = useFreshAssetUrl(environmentId, attachment ? null : resource, revision);
  const remoteUrl = AsyncResult.isSuccess(remote) && !remote.waiting ? remote.value : null;
  const uri = attachment ? localPreview.uri : (remoteUrl?.url ?? null);
  const needsText = kind === "text" || kind === "markdown" || (kind === "html" && !rendered);
  const text = useAtomValue(
    uri && needsText
      ? attachmentTextAtom({
          uri,
          authorizedAt: remoteUrl?.authorizedAt ?? null,
          environmentId,
          resource,
          sizeBytes: input.sizeBytes,
          revision,
        })
      : noAttachmentText,
  );
  const content = AsyncResult.isSuccess(text) ? text.value : null;
  const contentError = AsyncResult.isFailure(text)
    ? (Option.getOrNull(AsyncResult.error(text))?.message ?? "Could not read this file.")
    : null;
  const table = content && delimiter ? parseDelimitedPreview(content.text, delimiter) : null;
  const presentation = attachmentDocumentPresentation({
    kind,
    hasTable: table !== null,
    hasEnvironment: input.environmentId !== null,
    rendered,
  });
  const error = attachment
    ? localPreview.error && (localPreview.error.message || "The local file is unavailable.")
    : AsyncResult.isFailure(remote)
      ? (Option.getOrNull(AsyncResult.error(remote))?.message ?? "The attachment is unavailable.")
      : null;
  const share = async () => {
    if (!uri || sharing) return;
    setSharing(true);
    const controller = new AbortController();
    shareController.current = controller;
    const request = {
      attachment: { name: input.name, mimeType: input.mimeType },
      signal: controller.signal,
    };
    const result = await settlePromise(async () => {
      if (isLocalUri(uri)) await shareLocalAttachment({ ...request, uri });
      else await downloadAndShareAttachment({ ...request, url: (await refresh()) ?? uri });
    });
    if (shareController.current === controller) shareController.current = null;
    if (controller.signal.aborted) return;
    setSharing(false);
    if (AsyncResult.isFailure(result)) {
      const cause = squashAtomCommandFailure(result);
      Dialog.alert(
        "Could not share file",
        cause instanceof Error ? cause.message : "Please try again.",
      );
    }
  };
  return {
    kind,
    ...presentation,
    uri,
    /** Native viewers resolve their own fresh URL from this instead of reusing `uri`. */
    resource,
    content,
    table,
    error: error ?? contentError,
    needsText,
    rendered,
    setRendered,
    revision,
    retry: () => {
      setRevision((value) => value + 1);
      if (attachment) refreshLocalPreview();
    },
    share,
    sharing,
  };
}
