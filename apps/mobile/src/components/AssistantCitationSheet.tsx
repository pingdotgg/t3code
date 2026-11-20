import { ASSISTANT_CITATION_MAX_COMMENT_LENGTH, type AssistantCitation } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { T, useGT } from "gt-react-native";
import {
  Platform,
  ScrollView,
  type ScrollViewInstance,
  type TextInputInstance,
  View,
} from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useOpenAssistantCitationSource } from "../features/threads/useOpenAssistantCitationSource";
import { copyTextWithHaptic } from "../lib/copyTextWithHaptic";
import { AppText as Text, AppTextInput } from "./ui/AppText";
import { Button } from "./ui/Button";
import { IconButton } from "./ui/IconButton";
import { ListActionRow } from "./ui/ListActionRow";
import { ListSection } from "./ui/ListSection";
import { Sheet } from "./ui/Sheet";

const CONTEXT_CHARS = 80;
const ACTION_BAR_KEYBOARD_GAP = 8;

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

/** Editing a citation chip in a draft; without it the sheet only shows the quote. */
export interface AssistantCitationSheetEditor {
  /** A chip the cite just added: the comment takes focus, and Cancel takes the chip back out. */
  readonly fresh: boolean;
  /** False when the comment would make the draft too long to send. */
  readonly canSave: (comment: string) => boolean;
  readonly onSave: (comment: string) => void;
  readonly onSaveAndSend?: (comment: string) => void;
  readonly onRemove: () => void;
}

export function AssistantCitationSheet(props: {
  readonly citation: AssistantCitation;
  readonly editor?: AssistantCitationSheetEditor;
  /** Dismissing the sheet keeps an edited comment, like clicking away from web's editor. */
  readonly onClose: (comment: string | null) => void;
}) {
  const gt = useGT();
  const openCitationSource = useOpenAssistantCitationSource();
  const insets = useSafeAreaInsets();
  const { citation, editor } = props;
  const [comment, setComment] = useState(citation.comment ?? "");
  const changed = comment.trim() !== (citation.comment ?? "").trim();
  const tooLong = editor !== undefined && changed && !editor.canSave(comment);
  const keptComment = editor && changed && !tooLong ? comment : null;
  const actionBarBottomPadding = Math.max(12, insets.bottom);
  const scrollRef = useRef<ScrollViewInstance>(null);
  const commentRef = useRef<TextInputInstance>(null);
  // The comment is the last block, so following its caret means staying at the end.
  const keepCommentVisible = () => {
    if (commentRef.current?.isFocused()) scrollRef.current?.scrollToEnd();
  };
  return (
    <Sheet
      title={gt("Quote", { $context: "noun, a quoted passage" })}
      onClose={() => props.onClose(keptComment)}
    >
      <KeyboardAvoidingView
        behavior="padding"
        automaticOffset
        // The bar's safe-area padding may sit behind the keyboard; keep a small gap above it.
        keyboardVerticalOffset={ACTION_BAR_KEYBOARD_GAP - actionBarBottomPadding}
        enabled={editor !== undefined}
        className="flex-1"
      >
        <ScrollView
          ref={scrollRef}
          onLayout={keepCommentVisible}
          onContentSizeChange={keepCommentVisible}
          nestedScrollEnabled
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
          className="flex-1"
          contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
          contentContainerStyle={{
            paddingHorizontal: 20,
            paddingTop: 12,
            gap: 20,
            paddingBottom: editor ? 12 : Math.max(20, insets.bottom),
          }}
        >
          <View className="flex-row gap-3 rounded-2xl bg-grouped-card p-4">
            <View className="w-1 rounded-full bg-primary" />
            <Text
              selectable
              textRole="body"
              numberOfLines={editor ? 8 : undefined}
              className="min-w-0 flex-1 text-foreground-muted"
            >
              {contextBefore(citation.prefix)}
              <Text className="font-t3-medium text-foreground">{citation.text}</Text>
              {contextAfter(citation.suffix)}
            </Text>
          </View>
          {!editor && citation.comment ? (
            <ListSection title={gt("Comment", { $context: "noun" })}>
              <Text selectable textRole="body" className="px-4 py-3 text-foreground">
                {citation.comment}
              </Text>
            </ListSection>
          ) : null}
          <ListSection>
            <ListActionRow
              icon="arrow.up.right"
              label={gt("Go to message")}
              onPress={() => {
                props.onClose(keptComment);
                openCitationSource(citation);
              }}
            />
            <ListActionRow
              icon="doc.on.doc"
              label={gt("Copy quote")}
              onPress={() => copyTextWithHaptic(citation.text)}
            />
          </ListSection>
          {editor ? (
            <View className="gap-2">
              <AppTextInput
                ref={commentRef}
                accessibilityLabel={gt("Comment on quote")}
                placeholder={gt("Add an optional comment…")}
                multiline
                autoFocus={editor.fresh}
                maxLength={ASSISTANT_CITATION_MAX_COMMENT_LENGTH}
                textAlignVertical="top"
                className="max-h-40 min-h-24"
                value={comment}
                onChangeText={setComment}
              />
              {tooLong ? (
                <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
                  <T>This comment makes the message too long to send. Shorten it to save.</T>
                </Text>
              ) : null}
            </View>
          ) : null}
        </ScrollView>
        {editor ? (
          <View
            className="flex-row items-center gap-2 border-t border-border bg-sheet px-5 pt-2"
            style={{ paddingBottom: actionBarBottomPadding }}
          >
            <View className="flex-1">
              <Button
                label={editor.fresh ? gt("Cancel") : gt("Remove")}
                tone="secondary"
                size="compact"
                onPress={editor.onRemove}
              />
            </View>
            <View>
              <Button
                label={gt("Save")}
                tone={editor.onSaveAndSend ? "secondary" : "primary"}
                size="compact"
                disabled={tooLong}
                onPress={() => editor.onSave(comment)}
              />
            </View>
            {editor.onSaveAndSend ? (
              <IconButton
                accessibilityLabel={gt("Save and send")}
                icon="arrow.up"
                variant="primary"
                disabled={tooLong}
                onPress={() => editor.onSaveAndSend?.(comment)}
              />
            ) : null}
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </Sheet>
  );
}
