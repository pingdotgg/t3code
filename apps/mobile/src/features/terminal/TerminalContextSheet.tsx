import {
  ComposerContextId,
  COMPOSER_CONTEXT_TERMINAL_TEXT_MAX_CHARS,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import { useState } from "react";
import { Alert, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { REVIEW_MONO_FONT_FAMILY } from "../review/reviewDiffRendering";
import { AppText as Text } from "../../components/AppText";
import { AppSheet } from "../../components/AppSheet";
import { MaterialButton } from "../../components/MaterialButton";
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
    <AppSheet title="Terminal output" onClose={props.onClose}>
      <ScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: 20 }}
      >
        <Text className="pb-4 text-sm text-foreground-muted">
          Tap the first and last line to select a range.
        </Text>
        <View className="overflow-hidden rounded-xl bg-card-alt">
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
              className={
                index >= range.start && index <= range.end
                  ? "flex-row gap-3 bg-primary/10 px-3 py-2"
                  : "flex-row gap-3 px-3 py-2"
              }
            >
              <Text
                className="w-8 text-right text-sm text-foreground-muted"
                style={{ fontFamily: REVIEW_MONO_FONT_FAMILY }}
              >
                {index + 1}
              </Text>
              <Text
                className="flex-1 text-sm text-foreground"
                style={{ fontFamily: REVIEW_MONO_FONT_FAMILY }}
              >
                {line || " "}
              </Text>
            </Pressable>
          ))}
        </View>
      </ScrollView>
      <View
        className="gap-3 border-t border-border px-5 pt-4"
        style={{ paddingBottom: Math.max(16, insets.bottom) }}
      >
        {tooLarge ? (
          <Text className="text-sm text-foreground-muted">
            Select fewer lines to fit the context limit.
          </Text>
        ) : null}
        <MaterialButton
          label="Attach selected output"
          tone="primary"
          fullWidth
          disabled={!selectedText.trim() || tooLarge}
          onPress={attach}
        />
      </View>
    </AppSheet>
  );
}
