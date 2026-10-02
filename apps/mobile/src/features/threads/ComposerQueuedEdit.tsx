import type { ChatAttachment, EnvironmentId } from "@t3tools/contracts";
import { Image } from "expo-image";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { useAssetUrl } from "../../state/assets";

/**
 * The composer is shared, so editing a queued message needs a visible way back
 * out. This is that way out, and the only place the edit announces itself.
 */
export function ComposerQueuedEditBanner(props: {
  readonly saving: boolean;
  readonly onCancel: () => void;
}) {
  return (
    <View className="flex-row items-center gap-2 px-4 pb-2">
      <SymbolView name="pencil" size={12} tintColorClassName="accent-foreground-muted" />
      <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
        Editing queued message
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Cancel editing queued message"
        disabled={props.saving}
        onPress={props.onCancel}
        hitSlop={8}
        className="min-h-8 justify-center px-1 active:opacity-70 disabled:opacity-40"
      >
        <Text className="font-t3-medium text-xs text-primary">Cancel</Text>
      </Pressable>
    </View>
  );
}

/**
 * Attachments already on the queued message. They live on the server rather
 * than in the draft, so they get their own row: removing one here drops it
 * from the replacement list the edit sends.
 */
export function ComposerQueuedEditAttachments(props: {
  readonly environmentId: EnvironmentId;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly disabled: boolean;
  readonly onRemove: (attachmentId: string) => void;
}) {
  if (props.attachments.length === 0) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="always"
      className="grow-0"
      contentContainerClassName="flex-row items-center gap-2"
    >
      {props.attachments.map((attachment) => (
        <QueuedEditAttachmentChip
          key={attachment.id}
          environmentId={props.environmentId}
          attachment={attachment}
          disabled={props.disabled}
          onRemove={props.onRemove}
        />
      ))}
    </ScrollView>
  );
}

function QueuedEditAttachmentChip(props: {
  readonly environmentId: EnvironmentId;
  readonly attachment: ChatAttachment;
  readonly disabled: boolean;
  readonly onRemove: (attachmentId: string) => void;
}) {
  const { attachment } = props;
  const isImage = attachment.mimeType.startsWith("image/");
  const url = useAssetUrl(
    props.environmentId,
    isImage
      ? {
          _tag: "attachment",
          attachmentId: attachment.id,
          fileName: attachment.name,
          mimeType: attachment.mimeType,
          disposition: "inline",
        }
      : null,
  );

  return (
    <View className="max-w-[180px] flex-row items-center gap-2 rounded-xl border border-border bg-card py-1 pl-1 pr-2">
      {isImage && url !== null ? (
        <Image
          source={{ uri: url }}
          contentFit="cover"
          style={{ width: 24, height: 24, borderRadius: 6 }}
          accessibilityIgnoresInvertColors
        />
      ) : (
        <View className="h-6 w-6 items-center justify-center rounded-md bg-subtle">
          <SymbolView
            name={isImage ? "photo" : "doc"}
            size={12}
            tintColorClassName="accent-icon-subtle"
          />
        </View>
      )}
      <Text className="min-w-0 shrink text-xs text-foreground" numberOfLines={1}>
        {attachment.name}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Remove ${attachment.name}`}
        disabled={props.disabled}
        hitSlop={8}
        onPress={() => props.onRemove(attachment.id)}
        className="active:opacity-70 disabled:opacity-40"
      >
        <SymbolView name="xmark.circle.fill" size={14} tintColorClassName="accent-icon-subtle" />
      </Pressable>
    </View>
  );
}
