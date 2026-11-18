import * as Dialog from "../../components/ui/Dialog";
import {
  ComposerContextId,
  COMPOSER_CONTEXT_TERMINAL_TEXT_MAX_CHARS,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import { msg, T, useGT } from "gt-react-native";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MONO_FONT_FAMILY } from "../../lib/fonts";
import { AppText as Text } from "../../components/ui/AppText";
import { Sheet } from "../../components/ui/Sheet";
import { Button } from "../../components/ui/Button";
import { uuidv4 } from "../../lib/uuid";
import { m } from "../../i18n/messages";
import { insertComposerDraftContext } from "../../state/use-composer-drafts";

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
  const gt = useGT();
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
      // oxlint-disable-next-line t3code/no-untranslated-copy -- context label sent to the agent with the terminal text
      label: `${props.terminalLabel} · visible lines ${range.start + 1}–${range.end + 1}`,
      terminalId: props.terminalId,
      // oxlint-disable-next-line t3code/no-untranslated-copy -- context label sent to the agent with the terminal text
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
      Dialog.alert(
        m(msg("Too many context items")),
        m(msg("Remove some context from the draft and try again.")),
      );
      return;
    }
    props.onAttach();
  };
  return (
    <Sheet title={gt("Terminal output")} onClose={props.onClose}>
      <ScrollView
        nestedScrollEnabled
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: 20 }}
      >
        <Text className="pb-4 text-sm text-foreground-muted">
          <T>Tap the first and last line to select a range.</T>
        </Text>
        <View className="overflow-hidden rounded-xl bg-card-alt">
          {lines.map(
            (line, index) => (
              /* oxlint-disable react/no-array-index-key -- Selection is addressed by line number in this captured terminal snapshot. */ <Pressable
                key={index}
                accessibilityRole="button"
                accessibilityLabel={gt("Line {number}: {line}", { number: index + 1, line })}
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
                  style={{ fontFamily: MONO_FONT_FAMILY }}
                >
                  {index + 1}
                </Text>
                <Text
                  className="flex-1 text-sm text-foreground"
                  style={{ fontFamily: MONO_FONT_FAMILY }}
                >
                  {line || " "}
                </Text>
              </Pressable>
            ) /* oxlint-enable react/no-array-index-key */,
          )}
        </View>
      </ScrollView>
      <View
        className="gap-3 border-t border-foreground/12 px-5 pt-4"
        style={{ paddingBottom: Math.max(16, insets.bottom) }}
      >
        {tooLarge ? (
          <Text className="text-sm text-foreground-muted">
            <T>Select fewer lines to fit the context limit.</T>
          </Text>
        ) : null}
        <Button
          label={gt("Attach selected output")}
          tone="primary"
          fullWidth
          disabled={!selectedText.trim() || tooLarge}
          onPress={attach}
        />
      </View>
    </Sheet>
  );
}
