import { requireNativeModule } from "expo";
import { useEffect, useEffectEvent, useId } from "react";
import { Alert } from "react-native";

import type { ResolvedFilePreviewSource } from "./FilePreviewModal";
import { MediaImagePreview } from "./MediaImagePreview";

const NativeControls = requireNativeModule<{
  presentFile(
    uri: string,
    name: string,
    sourceIdentifier: string,
    identifier: string,
  ): Promise<void>;
  dismissFile(identifier: string): Promise<void>;
}>("T3NativeControls");

function NativeFilePreview(props: {
  readonly source: ResolvedFilePreviewSource;
  readonly onRequestClose: () => void;
}) {
  const { uri, name, sourceIdentifier } = props.source;
  const identifier = useId();
  const onRequestClose = useEffectEvent(props.onRequestClose);

  useEffect(() => {
    let canceled = false;
    void NativeControls.presentFile(uri, name ?? "Preview", sourceIdentifier ?? "", identifier)
      .catch(() => {
        if (!canceled) {
          Alert.alert("Could not open preview", "The file could not be loaded. Please try again.");
        }
      })
      .finally(() => {
        if (!canceled) onRequestClose();
      });
    return () => {
      canceled = true;
      void NativeControls.dismissFile(identifier).catch(() => undefined);
    };
  }, [uri, name, sourceIdentifier, identifier]);

  return null;
}

export function FilePreview(props: {
  readonly source: ResolvedFilePreviewSource;
  readonly onRequestClose: () => void;
}) {
  return props.source.kind === "image" && props.source.actionsSource ? (
    <MediaImagePreview {...props} />
  ) : (
    <NativeFilePreview {...props} />
  );
}
