import { Platform, Pressable, View, type StyleProp, type ViewStyle } from "react-native";

import { cn } from "../lib/cn";
import type { DraftComposerFileAttachment } from "../lib/composerImages";
import { SymbolView } from "./AppSymbol";
import { AppText } from "./AppText";
import { VideoAttachmentMenu } from "./VideoAttachmentMenu";
import { VideoThumbnailImage } from "./VideoThumbnailImage";

export function VideoAttachmentTile(props: {
  readonly name: string;
  readonly sourceIdentifier: string;
  readonly thumbnailSource: string | DraftComposerFileAttachment | null;
  readonly compact?: boolean;
  readonly onPress: (sourceIdentifier: string) => void;
  readonly onShare?: () => void;
  readonly disabled?: boolean;
  readonly className?: string;
  readonly style?: StyleProp<ViewStyle>;
}) {
  return (
    <VideoAttachmentMenu
      sourceIdentifier={props.sourceIdentifier}
      onOpen={() => props.onPress(props.sourceIdentifier)}
      onShare={props.onShare}
      disabled={props.disabled}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Play ${props.name}`}
        accessibilityHint={
          Platform.OS === "ios" && props.onShare
            ? "Touch and hold for save and share options"
            : undefined
        }
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
    </VideoAttachmentMenu>
  );
}
