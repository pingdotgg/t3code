import { requireNativeModule } from "expo";
import { useEffect, useEffectEvent, useId } from "react";
import { Alert } from "react-native";

import type { ResolvedFilePreviewSource } from "./FilePreviewModal";

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
  readonly onOpenError?: (error: unknown) => void;
}) {
  const { uri, name, sourceIdentifier } = props.source;
  const identifier = useId();
  const onRequestClose = useEffectEvent(props.onRequestClose);
  const onOpenError = useEffectEvent((error: unknown) => {
    if (props.onOpenError) props.onOpenError(error);
    else Alert.alert("Could not open preview", "The file could not be loaded. Please try again.");
  });

  useEffect(() => {
    let canceled = false;
    void NativeControls.presentFile(uri, name ?? "Preview", sourceIdentifier ?? "", identifier)
      .catch((error: unknown) => {
        if (!canceled) onOpenError(error);
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
  readonly onOpenError?: (error: unknown) => void;
}) {
  return <NativeFilePreview {...props} />;
}
