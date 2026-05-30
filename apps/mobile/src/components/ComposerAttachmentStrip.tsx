import { SymbolView } from "expo-symbols";
import { Image, Pressable, ScrollView, View } from "react-native";
import { useThemeColor } from "../lib/useThemeColor";

import type { DraftComposerImageAttachment } from "../lib/composerImages";

export interface ComposerAttachmentStripProps {
  /** Attachment images to display. */
  readonly attachments: ReadonlyArray<DraftComposerImageAttachment>;
  /** Called when the user taps the remove button on an image. */
  readonly onRemove: (imageId: string) => void;
  /** Called when the user taps on an image thumbnail to preview it. */
  readonly onPressImage?: (previewUri: string) => void;
  /** Image thumbnail size in points.  Defaults to 72. */
  readonly imageSize?: number;
  /** Border radius of each image thumbnail.  Defaults to 16. */
  readonly imageBorderRadius?: number;
  /** Whether the remove button should sit in its own gutter instead of overlapping the image. */
  readonly removeButtonPlacement?: "overlay" | "gutter";
}

/**
 * A horizontally-scrollable strip of image attachment thumbnails with remove
 * buttons.  Used by both the thread composer and the new-task draft screen.
 */
export function ComposerAttachmentStrip(props: ComposerAttachmentStripProps) {
  const subtleBg = useThemeColor("--color-subtle");
  const size = props.imageSize ?? 72;
  const radius = props.imageBorderRadius ?? 16;
  const removeButtonPlacement = props.removeButtonPlacement ?? "overlay";
  const removeButtonGutter = removeButtonPlacement === "gutter" ? 10 : 0;

  if (props.attachments.length === 0) {
    return null;
  }

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="always"
      style={{ flexGrow: 0 }}
    >
      <View style={{ flexDirection: "row", gap: 10 }}>
        {props.attachments.map((image) => (
          <View
            key={image.id}
            style={{
              position: "relative",
              paddingTop: removeButtonGutter,
              paddingRight: removeButtonGutter,
            }}
          >
            <Pressable
              onPress={props.onPressImage ? () => props.onPressImage!(image.previewUri) : undefined}
            >
              <Image
                source={{ uri: image.previewUri }}
                style={{
                  width: size,
                  height: size,
                  borderRadius: radius,
                  backgroundColor: subtleBg,
                }}
                resizeMode="cover"
              />
            </Pressable>
            <Pressable
              style={{
                position: "absolute",
                top: removeButtonPlacement === "gutter" ? 0 : 4,
                right: removeButtonPlacement === "gutter" ? 0 : 4,
                width: 22,
                height: 22,
                borderRadius: 11,
                backgroundColor: "rgba(0,0,0,0.55)",
                alignItems: "center",
                justifyContent: "center",
              }}
              hitSlop={6}
              onPress={() => props.onRemove(image.id)}
            >
              <SymbolView
                name="xmark"
                size={9}
                tintColor="#ffffff"
                type="monochrome"
                weight="bold"
              />
            </Pressable>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}
