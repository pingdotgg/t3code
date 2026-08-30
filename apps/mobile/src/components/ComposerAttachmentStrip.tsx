import { SymbolView } from "../components/AppSymbol";
import { Image, Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "./AppText";
import type { DraftComposerAttachment } from "../lib/composerImages";

export interface ComposerAttachmentStripProps {
  /** Attachments to display. */
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  /** Called when the user removes an attachment. */
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
 * Attachment thumbnails used by the thread composer and the new-task draft screen.
 */
export function ComposerAttachmentStrip(props: ComposerAttachmentStripProps) {
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
      className="grow-0"
    >
      <View className="flex-row gap-2.5">
        {props.attachments.map((attachment) => (
          <View
            key={attachment.id}
            className="relative"
            style={{
              paddingTop: removeButtonGutter,
              paddingRight: removeButtonGutter,
            }}
          >
            {attachment.type === "image" ? (
              <Pressable
                onPress={
                  props.onPressImage ? () => props.onPressImage!(attachment.previewUri) : undefined
                }
              >
                <Image
                  source={{ uri: attachment.previewUri }}
                  style={{
                    width: size,
                    height: size,
                    borderRadius: radius,
                  }}
                  className="bg-subtle"
                  resizeMode="cover"
                />
              </Pressable>
            ) : (
              <View
                className="items-center justify-center gap-1 bg-subtle px-2"
                style={{
                  width: size,
                  height: size,
                  borderRadius: radius,
                }}
              >
                <SymbolView name="doc.text" size={22} tintColor="#a3a3a3" type="monochrome" />
                <Text className="w-full text-center text-2xs text-foreground" numberOfLines={1}>
                  {attachment.name}
                </Text>
              </View>
            )}
            <Pressable
              className="absolute h-[22px] w-[22px] items-center justify-center rounded-[11px] bg-black/55"
              style={{
                top: removeButtonPlacement === "gutter" ? 0 : 4,
                right: removeButtonPlacement === "gutter" ? 0 : 4,
              }}
              hitSlop={6}
              onPress={() => props.onRemove(attachment.id)}
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
