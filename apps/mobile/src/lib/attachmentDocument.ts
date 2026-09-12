import { filePreviewDelimiter, parseDelimitedPreview } from "@t3tools/shared/delimitedPreview";
import type { EnvironmentId } from "@t3tools/contracts";
import { readFilePreviewResponse } from "@t3tools/client-runtime/file-preview";
import { filePreviewKind, FILE_TEXT_PREVIEW_MAX_BYTES } from "@t3tools/shared/filePreview";
import { fetch } from "expo/fetch";
import { File } from "expo-file-system";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert } from "react-native";

import type { FileBackedComposerAttachment } from "./composerImages";
import { loadLocalAttachmentPreview } from "./localAttachmentPreview";
import { downloadAndShareAttachment, shareLocalAttachment } from "./attachmentDownload";
import { useRefreshAssetUrl } from "../state/assets";

const isLocalUri = (uri: string) => /^(file|content):/.test(uri);

/** Signed asset URLs live for an hour; treat anything older than this as worth re-minting. */
const STALE_URL_MS = 5 * 60_000;

/**
 * Loads a captured attachment for viewing: a fresh signed URL for a sent or uploaded file,
 * a leased local file for a draft. Text kinds read a bounded prefix; documents hand their
 * URL to a native or web renderer. Captured bytes never resolve against the workspace.
 */
export function useAttachmentDocument(input: {
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly attachmentId: string;
  readonly environmentId: EnvironmentId | null;
  readonly attachment: FileBackedComposerAttachment | null;
}) {
  const kind = filePreviewKind(input);
  const delimiter = filePreviewDelimiter(input);
  const renderedMode =
    kind === "markdown" ? "markdown" : kind === "html" ? "html" : delimiter ? "table" : null;
  const shareController = useRef<AbortController | null>(null);
  useEffect(() => () => shareController.current?.abort(), []);
  const resource = useMemo(
    () => ({
      _tag: "attachment" as const,
      attachmentId: input.attachmentId,
      fileName: input.name,
      mimeType: input.mimeType,
      disposition: "inline" as const,
    }),
    [input.attachmentId, input.name, input.mimeType],
  );
  const environmentId = input.attachment ? null : input.environmentId;
  const refresh = useRefreshAssetUrl(environmentId, resource);
  const [localUri, setLocalUri] = useState<string | null>(null);
  const [remoteUri, setRemoteUri] = useState<string | null>(null);
  const [content, setContent] = useState<{ text: string; truncated: boolean } | null>(null);
  const table = useMemo(
    () => (content && delimiter ? parseDelimitedPreview(content.text, delimiter) : null),
    [content, delimiter],
  );
  const [error, setError] = useState<string | null>(null);
  // Reading source is a separate failure from loading the file: a rendered HTML page can be
  // fine while its bytes are not UTF-8, and switching back to the page must not stay stuck.
  const [contentError, setContentError] = useState<string | null>(null);
  const textReadUrl = useRef<{ uri: string; authorizedAt: number } | null>(null);
  const [rendered, setRendered] = useState(true);
  const [revision, setRevision] = useState(0);
  const [sharing, setSharing] = useState(false);
  const uri = input.attachment ? localUri : remoteUri;
  const attachment = input.attachment;
  useEffect(() => {
    if (attachment) return;
    let cancelled = false;
    // Await a fresh signed URL: cached links can expire while the client is suspended.
    // oxlint-disable-next-line react/set-state-in-effect -- A new preview request clears its previous URL and error.
    setRemoteUri(null);
    setError(null);
    textReadUrl.current = null;
    void refresh()
      .then((url) => {
        if (cancelled) return;
        if (!url) throw new Error("Reconnect to this environment and try again.");
        textReadUrl.current = { uri: url, authorizedAt: Date.now() };
        setRemoteUri(url);
      })
      .catch((cause: unknown) => {
        if (!cancelled)
          setError(cause instanceof Error ? cause.message : "The attachment is unavailable.");
      });
    return () => {
      cancelled = true;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Retry must reauthorize the remote file.
  }, [attachment, refresh, revision]);
  useEffect(() => {
    if (!attachment) return;
    // A new attachment must not keep the previous file behind it: `share()` would otherwise
    // send the old bytes under the new name if this load fails.
    // oxlint-disable-next-line react/set-state-in-effect -- A new attachment invalidates the last one.
    setLocalUri(null);
    setContent(null);
    setContentError(null);
    const controller = new AbortController();
    let release: (() => void) | undefined;
    void loadLocalAttachmentPreview(attachment, controller.signal)
      .then((file) => {
        if (!file) return;
        if (controller.signal.aborted) return file.dispose();
        release = file.dispose;
        setLocalUri(file.uri);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "The local file is unavailable.");
      });
    return () => {
      controller.abort();
      release?.();
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Retry must reacquire a local file lease after a failed load.
  }, [attachment, revision]);
  const needsText = kind === "text" || kind === "markdown" || (kind === "html" && !rendered);
  const sizeBytes = input.sizeBytes;
  useEffect(() => {
    if (!uri || !needsText) return;
    const controller = new AbortController();
    // oxlint-disable-next-line react/set-state-in-effect -- A new external resource must clear the previous response before loading.
    setContent(null);
    setContentError(null);
    const response = isLocalUri(uri)
      ? Promise.resolve().then(() => ({ ok: true, body: new File(uri).readableStream() }))
      : (async () => {
          // A signed URL minted when the file opened may have expired by the time the user
          // switches to source; reauthorize before fetching instead of reading a stale link.
          const authorized = textReadUrl.current;
          let target = authorized?.uri ?? uri;
          if (!authorized || Date.now() - authorized.authorizedAt > STALE_URL_MS) {
            const refreshed = await refresh();
            if (!refreshed) throw new Error("Reconnect to this environment and try again.");
            target = refreshed;
            if (!controller.signal.aborted) {
              // Keep the source-read URL and its age together without restarting active media.
              textReadUrl.current = { uri: refreshed, authorizedAt: Date.now() };
            }
          }
          return fetch(target, {
            signal: controller.signal,
            headers: {
              ...(sizeBytes > 0 ? { Range: `bytes=0-${FILE_TEXT_PREVIEW_MAX_BYTES}` } : {}),
              ...(revision > 0 ? { "Cache-Control": "no-cache" } : {}),
            },
          });
        })();
    void response
      .then((value) => readFilePreviewResponse(value, controller.signal))
      .then((value) => {
        if (!controller.signal.aborted) setContent(value);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setContentError(cause instanceof Error ? cause.message : "Could not read this file.");
      });
    return () => controller.abort();
  }, [uri, needsText, revision, sizeBytes, refresh]);
  const share = async () => {
    if (!uri || sharing) return;
    setSharing(true);
    const controller = new AbortController();
    shareController.current = controller;
    const request = {
      attachment: { name: input.name, mimeType: input.mimeType },
      signal: controller.signal,
    };
    try {
      if (isLocalUri(uri)) await shareLocalAttachment({ ...request, uri });
      else await downloadAndShareAttachment({ ...request, url: (await refresh()) ?? uri });
    } catch (cause) {
      if (controller.signal.aborted) return;
      Alert.alert(
        "Could not share file",
        cause instanceof Error ? cause.message : "Please try again.",
      );
    } finally {
      if (shareController.current === controller) shareController.current = null;
      if (!controller.signal.aborted) setSharing(false);
    }
  };
  return {
    kind,
    renderedMode,
    uri,
    /** Native viewers resolve their own fresh URL from this instead of reusing `uri`. */
    resource,
    content,
    table,
    error: error ?? (needsText ? contentError : null),
    needsText,
    rendered,
    setRendered,
    revision,
    retry: () => setRevision((value) => value + 1),
    share,
    sharing,
  };
}
