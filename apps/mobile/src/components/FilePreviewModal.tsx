import { useIsFocused } from "@react-navigation/native";
import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useState } from "react";
import { Alert, Keyboard } from "react-native";

import type { DraftComposerFileAttachment } from "../lib/composerImages";
import { loadLocalAttachmentPreview } from "../lib/localAttachmentPreview";
import type { MediaActionsSource } from "../lib/mediaActions";
import { useAssetUrlState } from "../state/assets";
import { usePreparedConnection } from "../state/session";
import { FilePreview } from "./FilePreview";

export interface ResolvedFilePreviewSource {
  readonly kind: "image" | "pdf";
  readonly uri: string;
  readonly name?: string;
  readonly sourceIdentifier?: string;
  readonly srcFragment?: string;
  readonly actionsSource?: MediaActionsSource;
}

export type FilePreviewSource = Omit<ResolvedFilePreviewSource, "uri"> &
  (
    | { readonly uri: string }
    | { readonly attachment: DraftComposerFileAttachment }
    | { readonly environmentId: EnvironmentId; readonly resource: AssetResource }
  );

function ResolvedFilePreview(props: {
  readonly source: FilePreviewSource;
  readonly onRequestClose: () => void;
}) {
  const { source } = props;
  const environmentId = "environmentId" in source ? source.environmentId : null;
  const connection = usePreparedConnection(environmentId);
  const asset = useAssetUrlState(environmentId, "resource" in source ? source.resource : null);
  // Keep the original URL through dismissal; a refreshed signature must not reopen the viewer.
  const [uri, setUri] = useState<string | null>("uri" in source ? source.uri : null);
  const onRequestClose = useEffectEvent(props.onRequestClose);
  const failed =
    environmentId !== null &&
    uri === null &&
    (connection._tag === "None" || asset._tag === "Failure");
  useEffect(() => Keyboard.dismiss(), []);
  useEffect(() => {
    if (uri === null && asset._tag === "Success") setUri(asset.url + (source.srcFragment ?? ""));
  }, [uri, asset, source.srcFragment]);
  useEffect(() => {
    if (!failed) return;
    Alert.alert(
      "Could not open preview",
      connection._tag === "None"
        ? "Reconnect to this environment and try again."
        : "The file could not be loaded. It may have been moved or deleted.",
    );
    onRequestClose();
  }, [failed, connection._tag]);
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
      .catch(() => {
        if (controller.signal.aborted) return;
        Alert.alert("Could not open preview", "Attach the file again and retry.");
        onRequestClose();
      });
    return () => {
      controller.abort();
      release?.();
    };
  }, [source]);

  return uri === null ? null : (
    <FilePreview source={{ ...source, uri }} onRequestClose={props.onRequestClose} />
  );
}

export function FilePreviewModal(props: {
  readonly source: FilePreviewSource | null;
  readonly onRequestClose: () => void;
}) {
  const isFocused = useIsFocused();
  const hasSource = props.source !== null;
  const onRequestClose = useEffectEvent(props.onRequestClose);
  useEffect(() => {
    if (!isFocused && hasSource) onRequestClose();
  }, [isFocused, hasSource]);

  if (!props.source || !isFocused) return null;
  return <ResolvedFilePreview source={props.source} onRequestClose={props.onRequestClose} />;
}
