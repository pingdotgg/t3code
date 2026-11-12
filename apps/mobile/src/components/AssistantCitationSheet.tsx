import { ASSISTANT_CITATION_MAX_COMMENT_LENGTH, type AssistantCitation } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useState } from "react";
import { Platform, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useOpenLinkedThread } from "../features/threads/useOpenLinkedThread";
import { requestThreadMessageJump } from "../features/threads/threadMessageJump";
import { copyTextWithHaptic } from "../lib/copyTextWithHaptic";
import { AppText as Text } from "./ui/AppText";
import { ListActionRow } from "./ui/ListActionRow";
import { ListSection } from "./ui/ListSection";
import { Sheet } from "./ui/Sheet";

const CONTEXT_CHARS = 80;

function contextBefore(prefix: string) {
  const flat = prefix.replace(/\s+/g, " ");
  if (flat.length <= CONTEXT_CHARS) return flat.trimStart();
  const cut = flat.slice(-CONTEXT_CHARS);
  return `…${cut.slice(cut.indexOf(" ") + 1)}`;
}

function contextAfter(suffix: string) {
  const flat = suffix.replace(/\s+/g, " ");
  if (flat.length <= CONTEXT_CHARS) return flat.trimEnd();
  const cut = flat.slice(0, CONTEXT_CHARS);
  return `${cut.slice(0, cut.lastIndexOf(" "))}…`;
}

export function AssistantCitationSheet(props: {
  readonly citation: AssistantCitation;
  readonly onClose: () => void;
  readonly onRemove?: () => void;
  readonly onCommentChange?: (comment: string) => void;
  readonly canChangeComment?: (comment: string) => boolean;
}) {
  const openLinkedThread = useOpenLinkedThread();
  const insets = useSafeAreaInsets();
  const citation = props.citation;
  const [comment, setComment] = useState(citation.comment ?? "");
  const commentChanged = comment.trim() !== (citation.comment ?? "");
  const commentTooLong = commentChanged && props.canChangeComment?.(comment) === false;
  const close = () => {
    if (commentTooLong) return;
    if (props.onCommentChange && commentChanged) {
      props.onCommentChange(comment);
    }
    props.onClose();
  };
  return (
    <Sheet title="Quote" onClose={close} dismissDisabled={commentTooLong}>
      <ScrollView
        contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingTop: 12,
          gap: 24,
          paddingBottom: Math.max(20, insets.bottom),
        }}
      >
        <View className="flex-row gap-3 rounded-2xl bg-grouped-card p-4">
          <View className="w-1 rounded-full bg-primary" />
          <Text selectable textRole="body" className="min-w-0 flex-1 text-foreground-muted">
            {contextBefore(citation.prefix)}
            <Text className="font-t3-medium text-foreground">{citation.text}</Text>
            {contextAfter(citation.suffix)}
          </Text>
        </View>
        {props.onCommentChange ? (
          <ListSection title="Comment">
            <TextInput
              accessibilityLabel="Comment on quote"
              placeholder="Add an optional comment…"
              placeholderTextColorClassName="accent-foreground-muted"
              multiline
              maxLength={ASSISTANT_CITATION_MAX_COMMENT_LENGTH}
              value={comment}
              onChangeText={setComment}
              className="min-h-24 px-4 py-3 text-base text-foreground"
              style={{ textAlignVertical: "top" }}
            />
            {commentTooLong ? (
              <Text textRole="body" className="px-4 pb-3 text-foreground-muted">
                This comment makes the message too long to send. Shorten it to save and close.
              </Text>
            ) : null}
          </ListSection>
        ) : citation.comment ? (
          <ListSection title="Comment">
            <Text selectable textRole="body" className="px-4 py-3 text-foreground">
              {citation.comment}
            </Text>
          </ListSection>
        ) : null}
        <ListSection>
          <ListActionRow
            icon="arrow.up.right"
            label="Go to message"
            onPress={() => {
              if (commentTooLong) return;
              close();
              requestThreadMessageJump(scopedThreadKey(citation), citation.messageId);
              openLinkedThread(citation);
            }}
          />
          <ListActionRow
            icon="doc.on.doc"
            label="Copy quote"
            onPress={() => copyTextWithHaptic(citation.text)}
          />
          {props.onRemove ? (
            <ListActionRow
              icon="trash"
              label="Remove from draft"
              tone="danger"
              onPress={props.onRemove}
            />
          ) : null}
        </ListSection>
      </ScrollView>
    </Sheet>
  );
}
