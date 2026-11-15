import { ASSISTANT_CITATION_MAX_COMMENT_LENGTH, type AssistantCitation } from "@t3tools/contracts";
import { Image } from "expo-image";
import { useRef, useState } from "react";
import {
  Platform,
  ScrollView,
  type ScrollViewInstance,
  type TextInputInstance,
  View,
} from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { contextChipPresentation } from "../lib/composerChipPresentation";
import { CONTEXT_CHIP_ICON_SOURCES } from "../lib/contextChipIcons.generated";
import { Button } from "./ui/Button";
import { IconButton } from "./ui/IconButton";
import { AppText as Text, AppTextInput } from "./ui/AppText";
import { Sheet } from "./ui/Sheet";

const CITATION_ACCENT = contextChipPresentation("citation").accent;
const ACTION_BAR_KEYBOARD_GAP = 8;

/** Editing a citation chip in a draft; without it the sheet only shows the quote. */
export interface AssistantCitationSheetEditor {
  /** A chip the cite just added: Cancel takes it back out, as web does. */
  readonly fresh: boolean;
  readonly onSave: (comment: string) => void;
  readonly onSaveAndSend?: (comment: string) => void;
  readonly onRemove: () => void;
}

export function AssistantCitationSheet(props: {
  readonly citation: AssistantCitation;
  readonly editor?: AssistantCitationSheetEditor;
  readonly onGoToSource?: () => void;
  /** Dismissing the sheet keeps an edited comment, like clicking away from web's editor. */
  readonly onClose: (comment: string | null) => void;
}) {
  const insets = useSafeAreaInsets();
  const [comment, setComment] = useState(props.citation.comment ?? "");
  const tooLong = comment.length > ASSISTANT_CITATION_MAX_COMMENT_LENGTH;
  const editor = props.editor;
  const changed = comment.trim() !== (props.citation.comment ?? "").trim();
  const keptComment = editor && changed && !tooLong ? comment : null;
  const actionBarBottomPadding = Math.max(12, insets.bottom);
  const scrollRef = useRef<ScrollViewInstance>(null);
  const commentRef = useRef<TextInputInstance>(null);
  // The comment is the last block, so following its caret means staying at the end.
  const keepCommentVisible = () => {
    if (commentRef.current?.isFocused()) scrollRef.current?.scrollToEnd();
  };
  return (
    <Sheet title="Quote" onClose={() => props.onClose(keptComment)}>
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
            gap: 12,
            paddingBottom: editor ? 12 : Math.max(20, insets.bottom),
          }}
        >
          <View className="gap-3 rounded-2xl border border-border bg-card px-4 py-3.5">
            <View className="flex-row gap-3">
              <Image
                source={CONTEXT_CHIP_ICON_SOURCES.quote}
                tintColor={CITATION_ACCENT}
                style={{ width: 18, height: 18, marginTop: 2 }}
              />
              <Text selectable numberOfLines={8} className="flex-1 text-base text-foreground">
                {props.citation.text}
              </Text>
            </View>
            {!editor && props.citation.comment ? (
              <View className="border-t border-border pt-3">
                <Text selectable className="text-base text-foreground-muted">
                  {props.citation.comment}
                </Text>
              </View>
            ) : null}
          </View>
          {props.onGoToSource ? (
            <Button
              label="Go to source"
              icon="arrow.up.right"
              tone="text"
              size="compact"
              onPress={() => {
                props.onGoToSource?.();
                props.onClose(keptComment);
              }}
            />
          ) : null}
          {editor ? (
            <>
              <AppTextInput
                ref={commentRef}
                accessibilityLabel="Comment on selected text"
                placeholder="Add an optional comment..."
                multiline
                autoFocus={editor.fresh}
                textAlignVertical="top"
                className="max-h-40 min-h-24"
                value={comment}
                onChangeText={setComment}
              />
              {tooLong ? (
                <Text accessibilityRole="alert" className="text-xs text-destructive">
                  Comments can contain up to{" "}
                  {ASSISTANT_CITATION_MAX_COMMENT_LENGTH.toLocaleString()} characters.
                </Text>
              ) : null}
            </>
          ) : null}
        </ScrollView>
        {editor ? (
          <View
            className="flex-row items-center gap-2 border-t border-border bg-sheet px-5 pt-2"
            style={{ paddingBottom: actionBarBottomPadding }}
          >
            <View className="flex-1">
              <Button
                label={editor.fresh ? "Cancel" : "Remove"}
                tone="secondary"
                size="compact"
                onPress={editor.onRemove}
              />
            </View>
            <View>
              <Button
                label={tooLong ? "Shorten comment" : "Save"}
                tone={editor.onSaveAndSend ? "secondary" : "primary"}
                size="compact"
                disabled={tooLong}
                onPress={() => editor.onSave(comment)}
              />
            </View>
            {editor.onSaveAndSend ? (
              <IconButton
                accessibilityLabel="Save and send"
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
