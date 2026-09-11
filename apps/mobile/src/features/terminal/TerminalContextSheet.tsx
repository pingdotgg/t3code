import {
  ComposerContextId,
  COMPOSER_CONTEXT_TERMINAL_TEXT_MAX_CHARS,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import { useState } from "react";
import { Alert, Modal, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { REVIEW_MONO_FONT_FAMILY } from "../review/reviewDiffRendering";
import { AppText as Text } from "../../components/AppText";
import { uuidv4 } from "../../lib/uuid";
import { insertComposerDraftContext } from "../../state/use-composer-drafts";

/** Line numbers are relative to this frozen viewport, not the terminal's scrollback. */
export function TerminalContextSheet(props: {
  text: string;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  terminalId: string;
  terminalLabel: string;
  onClose: () => void;
  onAttach: () => void;
}) {
  const insets = useSafeAreaInsets();
  const lines = props.text.replace(/\n+$/, "").split("\n");
  const [range, setRange] = useState({ start: 0, end: lines.length - 1 });
  const [anchor, setAnchor] = useState<number | null>(null);
  const selectedText = lines.slice(range.start, range.end + 1).join("\n");
  const tooLarge = selectedText.length > COMPOSER_CONTEXT_TERMINAL_TEXT_MAX_CHARS;
  const attach = () => {
    if (!selectedText.trim() || tooLarge) return;
    const record = {
      version: 1 as const,
      kind: "terminal" as const,
      contextId: ComposerContextId.make(uuidv4()),
      label: `${props.terminalLabel} · visible lines ${range.start + 1}–${range.end + 1}`,
      terminalId: props.terminalId,
      terminalLabel: `${props.terminalLabel} (visible output)`,
      lineStart: range.start + 1,
      lineEnd: range.end + 1,
      text: selectedText,
    };
    if (
      !insertComposerDraftContext(`${props.environmentId}:${props.threadId}`, {
        text: formatComposerContextReference(record),
        context: { version: 1, records: [record] },
      })
    ) {
      Alert.alert("Too many context items", "Remove some context from the draft and try again.");
      return;
    }
    props.onAttach();
  };
  return (
    <Modal presentationStyle="pageSheet" animationType="slide" onRequestClose={props.onClose}>
      <View
        className="flex-1 bg-sheet-solid"
        style={
          Platform.OS === "android"
            ? { paddingTop: insets.top, paddingBottom: insets.bottom }
            : undefined
        }
      >
        <View className="flex-row items-center justify-between p-4">
          <Text className="text-lg text-foreground">Visible terminal output</Text>
          <Pressable accessibilityRole="button" onPress={props.onClose} className="p-3">
            <Text className="text-foreground">Cancel</Text>
          </Pressable>
        </View>
        <Text className="px-4 pb-3 text-foreground-muted">
          Tap the first and last line to select a range.
        </Text>
        <ScrollView className="flex-1" contentContainerStyle={{ padding: 16 }}>
          {lines.map((line, index) => (
            <Pressable
              key={index}
              accessibilityRole="button"
              accessibilityLabel={`Line ${index + 1}: ${line}`}
              accessibilityState={{ selected: index >= range.start && index <= range.end }}
              onPress={() => {
                if (anchor === null) {
                  setAnchor(index);
                  setRange({ start: index, end: index });
                } else {
                  setRange({ start: Math.min(anchor, index), end: Math.max(anchor, index) });
                  setAnchor(null);
                }
              }}
              className={index >= range.start && index <= range.end ? "bg-subtle py-1" : "py-1"}
            >
              <Text
                className="text-sm text-foreground"
                style={{ fontFamily: REVIEW_MONO_FONT_FAMILY }}
              >
                {index + 1} {line || " "}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
        {tooLarge ? (
          <Text className="px-4 text-foreground-muted">
            Select fewer lines to fit the context limit.
          </Text>
        ) : null}
        <Pressable
          accessibilityRole="button"
          disabled={!selectedText.trim() || tooLarge}
          onPress={attach}
          className="m-4 mb-10 rounded-xl bg-subtle p-4"
        >
          <Text className="text-center text-foreground">Attach selected output</Text>
        </Pressable>
      </View>
    </Modal>
  );
}
