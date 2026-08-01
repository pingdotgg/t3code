import { SymbolView } from "../components/AppSymbol";
import { useState } from "react";
import { Image, Pressable, ScrollView, View } from "react-native";
import { useThemeColor } from "../lib/useThemeColor";

import { ImageMarkupModal } from "../features/annotations/ImageMarkupModal";
import type { DraftComposerImageAttachment } from "../lib/composerImages";

export interface ComposerAttachmentStripProps {
  /** Attachment images to display. */
  readonly attachments: ReadonlyArray<DraftComposerImageAttachment>;
  /** Called when the user taps the remove button on an image. */
  readonly onRemove: (imageId: string) => void;
  /** Replaces an attachment after adding, editing, or removing image markup. */
  readonly onReplace?: (image: DraftComposerImageAttachment) => void;
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
  const [markupAttachment, setMarkupAttachment] = useState<DraftComposerImageAttachment | null>(
    null,
  );
  const size = props.imageSize ?? 72;
  const radius = props.imageBorderRadius ?? 16;
  const removeButtonPlacement = props.removeButtonPlacement ?? "overlay";
  const removeButtonGutter = removeButtonPlacement === "gutter" ? 10 : 0;

  if (props.attachments.length === 0) {
    return null;
  }

  return (
    <>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="always"
        className="grow-0"
      >
        <View className="flex-row gap-2.5">
          {props.attachments.map((image) => (
            <View
              key={image.id}
              className="relative"
              style={{
                paddingTop: removeButtonGutter,
                paddingRight: removeButtonGutter,
              }}
            >
              <Pressable
                onPress={
                  props.onPressImage ? () => props.onPressImage!(image.previewUri) : undefined
                }
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
                accessibilityRole="button"
                accessibilityLabel={`Remove ${image.name}`}
                className="absolute h-[22px] w-[22px] items-center justify-center rounded-[11px] bg-black/55"
                style={{
                  top: removeButtonPlacement === "gutter" ? 0 : 4,
                  right: removeButtonPlacement === "gutter" ? 0 : 4,
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
              {props.onReplace ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${image.markup ? "Edit" : "Add"} markup for ${image.name}`}
                  className="absolute h-7 w-7 items-center justify-center rounded-[14px] bg-black/60"
                  style={{
                    right: removeButtonGutter + 4,
                    bottom: 4,
                  }}
                  hitSlop={6}
                  onPress={() => setMarkupAttachment(image)}
                >
                  <SymbolView
                    name="square.and.pencil"
                    size={13}
                    tintColor="#ffffff"
                    type="monochrome"
                  />
                </Pressable>
              ) : null}
            </View>
          ))}
        </View>
      </ScrollView>
      <ImageMarkupModal
        attachment={markupAttachment}
        visible={markupAttachment !== null}
        onCancel={() => setMarkupAttachment(null)}
        onDone={(image) => {
          props.onReplace?.(image);
          setMarkupAttachment(null);
        }}
      />
    </>
  );
}
