import { Platform, Pressable, View, type StyleProp, type ViewStyle } from "react-native";

import { cn } from "../lib/cn";
import type { DraftComposerFileAttachment } from "../lib/composerImages";
import { useMediaActions, type MediaActionsSource } from "../lib/mediaActions";
import { SymbolView } from "./AppSymbol";
import { AppText } from "./AppText";
import { MediaActionsMenu } from "./MediaActionsMenu";
import { PresentationSource } from "./NativePresentation";
import { VideoThumbnailImage } from "./VideoThumbnailImage";

export function VideoAttachmentTile(props: {
  readonly name: string;
  readonly sourceIdentifier: string;
  readonly thumbnailSource: string | DraftComposerFileAttachment | null;
  readonly actionsSource?: MediaActionsSource;
  readonly compact?: boolean;
  readonly onPress: (sourceIdentifier: string) => void;
  readonly disabled?: boolean;
  readonly className?: string;
  readonly style?: StyleProp<ViewStyle>;
}) {
  const mediaActions = useMediaActions(props.disabled ? undefined : props.actionsSource);
  const hasActions = mediaActions.actions.length > 0;
  return (
    <PresentationSource
      identifier={props.sourceIdentifier}
      accessible={Platform.OS === "ios"}
      accessibilityRole="button"
      accessibilityLabel={`Play ${props.name}`}
      accessibilityState={{ disabled: props.disabled ?? false }}
      onAccessibilityTap={() => {
        if (!props.disabled) props.onPress(props.sourceIdentifier);
      }}
      accessibilityActions={mediaActions.actions.map(({ id, title }) => ({
        name: id,
        label: title,
      }))}
      onAccessibilityAction={({ nativeEvent }) => {
        if (props.disabled) return;
        mediaActions.actions.find(({ id }) => id === nativeEvent.actionName)?.run();
      }}
    >
      <MediaActionsMenu media={mediaActions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Play ${props.name}`}
          accessibilityHint={hasActions ? "Touch and hold for media actions" : undefined}
          accessibilityState={{ disabled: props.disabled ?? false }}
          disabled={props.disabled}
          onPress={() => props.onPress(props.sourceIdentifier)}
          className={cn("items-center justify-center overflow-hidden bg-black/80", props.className)}
          style={props.style}
        >
          <VideoThumbnailImage cacheKey={props.sourceIdentifier} source={props.thumbnailSource} />
          <View
            className={cn(
              "items-center justify-center rounded-full bg-black/45",
              props.compact ? "size-6" : "size-12",
            )}
          >
            <SymbolView
              name="play"
              size={props.compact ? 15 : 24}
              tintColor="#ffffff"
              type="monochrome"
            />
          </View>
          {!props.compact ? (
            <View className="absolute inset-x-0 bottom-0 bg-black/55 px-2 py-1.5">
              <AppText className="text-center text-xs text-white" numberOfLines={1}>
                {props.name}
              </AppText>
            </View>
          ) : null}
        </Pressable>
      </MediaActionsMenu>
    </PresentationSource>
  );
}
