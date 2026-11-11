import { useNavigation } from "@react-navigation/native";
import { useEffect, useEffectEvent } from "react";
import { Keyboard } from "react-native";

import { mediaVideoThumbnailKey, type VideoPreviewSource } from "./videoPreviewSource";

/** Identity of a video preview: a different file is a new presentation. */
export function videoPreviewKey(source: VideoPreviewSource): string {
  return source.type === "local"
    ? `local:${source.attachment.id}:${source.attachment.fileUri}`
    : mediaVideoThumbnailKey(source);
}

/**
 * A full-screen preview owns the screen while it is open: each presented
 * source dismisses the keyboard, and the preview closes when its route loses
 * focus, so navigating away never leaves a native viewer or modal behind.
 * `presentationKey` is the presented source's identity, or null when closed.
 */
export function usePreviewPresentation(
  presentationKey: string | null,
  onRequestClose: () => void,
): void {
  // The v5 card host sits inside a legacy presentation envelope whose focus context
  // can describe a different route. The preview belongs to this navigation route.
  const navigation = useNavigation();
  const close = useEffectEvent(onRequestClose);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Navigation blur is an external event and the open state belongs to the caller.
  useEffect(() => {
    if (presentationKey === null) return;
    Keyboard.dismiss();
    if (!navigation.isFocused()) {
      close();
      return;
    }
    return navigation.addListener("blur", () => close());
  }, [presentationKey, navigation]);
}
