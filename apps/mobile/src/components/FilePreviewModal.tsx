import { useIsFocused } from "@react-navigation/native";
import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useState } from "react";
import { Alert, Keyboard } from "react-native";

import type { FileBackedComposerAttachment } from "../lib/composerImages";
import { loadLocalAttachmentPreview } from "../lib/localAttachmentPreview";
import type { MediaActionsSource } from "../lib/mediaActions";
import { useRefreshAssetUrl } from "../state/assets";
import { FilePreview } from "./FilePreview";

export interface ResolvedFilePreviewSource {
  readonly kind: "image" | "pdf" | "document";
  readonly mimeType?: string;
  readonly uri: string;
  readonly name?: string;
  readonly sourceIdentifier?: string;
  readonly srcFragment?: string;
  readonly actionsSource?: MediaActionsSource;
}

export type FilePreviewSource = Omit<ResolvedFilePreviewSource, "uri"> &
  (
    | { readonly uri: string }
    | { readonly attachment: FileBackedComposerAttachment }
    | { readonly environmentId: EnvironmentId; readonly resource: AssetResource }
  );

function ResolvedFilePreview(props: {
  readonly source: FilePreviewSource;
  readonly onRequestClose: () => void;
  readonly onOpenError?: (error: unknown) => void;
}) {
  const { source } = props;
  const environmentId = "environmentId" in source ? source.environmentId : null;
  const refreshAssetUrl = useRefreshAssetUrl(
    environmentId,
    "resource" in source ? source.resource : null,
  );
  // Resolve once per presentation; background URL refreshes must not reopen the native viewer.
  const [uri, setUri] = useState<string | null>("uri" in source ? source.uri : null);
  const onRequestClose = useEffectEvent(props.onRequestClose);
  const onResolutionError = useEffectEvent((error: unknown, fallbackMessage: string) => {
    if (props.onOpenError) props.onOpenError(error);
    else Alert.alert("Could not open preview", fallbackMessage);
    onRequestClose();
  });
  useEffect(() => Keyboard.dismiss(), []);
  useEffect(() => {
    if (environmentId === null || uri !== null) return;
    let cancelled = false;
    // A cached URL may have expired while the app was suspended. Await reauthorization
    // before handing a URL to Quick Look or ACTION_VIEW, which retain that URL.
    void refreshAssetUrl()
      .then((url) => {
        if (cancelled) return;
        if (!url) throw new Error("Reconnect to this environment and try again.");
        setUri(url + (source.srcFragment ?? ""));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        onResolutionError(
          error,
          "Reconnect to this environment and try again. The file may have been moved or deleted.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [environmentId, uri, refreshAssetUrl, source.srcFragment]);
  useEffect(() => {
    if (!("attachment" in source)) return;
    const controller = new AbortController();
    let release: (() => void) | undefined;
    void loadLocalAttachmentPreview(source.attachment, controller.signal)
      .then((file) => {
        if (!file) return;
        if (controller.signal.aborted) {
          file.dispose();
          return;
        }
        release = file.dispose;
        setUri(file.uri);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        onResolutionError(error, "Attach the file again and retry.");
      });
    return () => {
      controller.abort();
      release?.();
    };
  }, [source]);

  return uri === null ? null : (
    <FilePreview
      source={{ ...source, uri }}
      onRequestClose={props.onRequestClose}
      {...(props.onOpenError ? { onOpenError: props.onOpenError } : {})}
    />
  );
}

export function FilePreviewModal(props: {
  readonly source: FilePreviewSource | null;
  readonly onRequestClose: () => void;
  /** Replaces the default alert when the platform cannot open the document. */
  readonly onOpenError?: (error: unknown) => void;
}) {
  const isFocused = useIsFocused();
  const hasSource = props.source !== null;
  const onRequestClose = useEffectEvent(props.onRequestClose);
  useEffect(() => {
    if (!isFocused && hasSource) onRequestClose();
  }, [isFocused, hasSource]);

  if (!props.source || !isFocused) return null;
  return (
    <ResolvedFilePreview
      source={props.source}
      onRequestClose={props.onRequestClose}
      {...(props.onOpenError ? { onOpenError: props.onOpenError } : {})}
    />
  );
}
