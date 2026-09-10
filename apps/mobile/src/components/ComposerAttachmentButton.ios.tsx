import { requireNativeModule, requireNativeView } from "expo";
import type { ComponentProps } from "react";
import { Alert, type ColorValue, type ViewProps } from "react-native";
import { ComposerAttachmentMenu } from "./ComposerAttachmentMenu";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { mobilePreferencesAtom } from "../state/preferences";
import { withUniwind } from "uniwind";

const nativeControls = requireNativeModule<{
  finishRecentPhotoSelection: (selectionId: string, identifier: string) => Promise<void>;
}>("T3NativeControls");

const NativeButton = requireNativeView<
  ViewProps & {
    recentPhotosEnabled: boolean;
    disabled: boolean;
    supportsFiles: boolean;
    iconColor?: ColorValue;
    onPickMedia: () => void;
    onPickFiles: () => void;
    onPickPhoto: (event: { nativeEvent: { assetId: string; selectionId: string } }) => void;
  }
>("T3NativeControls", "RecentPhotosButton");

const ThemedNativeButton = withUniwind(NativeButton, {
  iconColor: { fromClassName: "iconColorClassName", styleProperty: "accentColor" },
});

export function ComposerAttachmentButton(props: ComponentProps<typeof ComposerAttachmentMenu>) {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const enabled =
    AsyncResult.isSuccess(preferences) && preferences.value.recentPhotosEnabled === true;
  const onPickRecentPhoto = props.onPickRecentPhoto;
  if (!enabled || !onPickRecentPhoto) return <ComposerAttachmentMenu {...props} />;
  return (
    <ThemedNativeButton
      style={{ width: 44, height: 44, flexShrink: 0 }}
      recentPhotosEnabled={enabled}
      disabled={props.disabled ?? false}
      supportsFiles={props.supportsFiles}
      iconColorClassName="accent-icon"
      onPickMedia={() => void props.onPickMedia()}
      onPickFiles={() => void props.onPickFiles()}
      onPickPhoto={async ({ nativeEvent }) => {
        let attachmentId: string | undefined;
        try {
          attachmentId = await onPickRecentPhoto(nativeEvent.assetId);
        } catch {
          Alert.alert("Couldn't attach photo", "Try again or choose it from Photo Library.");
        } finally {
          requestAnimationFrame(() => {
            void nativeControls.finishRecentPhotoSelection(
              nativeEvent.selectionId,
              attachmentId ? `draft-image:${attachmentId}` : "",
            );
          });
        }
      }}
    />
  );
}
