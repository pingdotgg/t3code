import * as Dialog from "../../components/ui/Dialog";
import { LegendList } from "@legendapp/list/react-native";
import {
  ComposerContextId,
  COMPOSER_CONTEXT_TERMINAL_TEXT_MAX_CHARS,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import { msg, T, useGT } from "gt-react-native";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText as Text } from "../../components/ui/AppText";
import { Sheet } from "../../components/ui/Sheet";
import { Button } from "../../components/ui/Button";
import { uuidv4 } from "../../lib/uuid";
import { m } from "../../i18n/messages";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { insertComposerDraftContext } from "../../state/use-composer-drafts";

export function TerminalContextSheet(props: {
  text: string;
  /** Rows on screen when the output was captured; the latest screenful starts selected. */
  visibleRows: number;
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
  const [range, setRange] = useState(() => ({
    start: Math.max(0, lines.length - props.visibleRows),
    end: lines.length - 1,
  }));
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
      label: `${props.terminalLabel} · lines ${range.start + 1}–${range.end + 1}`,
      terminalId: props.terminalId,
      terminalLabel: props.terminalLabel,
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
  const selectLine = (index: number) => {
    if (anchor === null) {
      setAnchor(index);
      setRange({ start: index, end: index });
    } else {
      setRange({ start: Math.min(anchor, index), end: Math.max(anchor, index) });
      setAnchor(null);
    }
  };
  return (
    <Sheet title={gt("Terminal output")} onClose={props.onClose}>
      <LegendList
        renderScrollComponent={NativeScrollView}
        data={lines}
        keyExtractor={(_line, index) => String(index)}
        extraData={{ range, anchor }}
        estimatedItemSize={36}
        recycleItems
        initialScrollAtEnd
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: 20 }}
        ListHeaderComponent={
          <Text className="pb-4 text-sm text-foreground-muted">
            <T>Tap the first and last line to select a range.</T>
          </Text>
        }
        renderItem={({ item: line, index }) => {
          const selected = index >= range.start && index <= range.end;
          const edge =
            (index === 0 ? " rounded-t-xl" : "") +
            (index === lines.length - 1 ? " rounded-b-xl" : "");
          return (
            <View className={`overflow-hidden bg-card-alt${edge}`}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={gt("Line {number}: {line}", { number: index + 1, line })}
                accessibilityState={{ selected }}
                onPress={() => selectLine(index)}
                className={
                  selected ? "flex-row gap-3 bg-primary/10 px-3 py-2" : "flex-row gap-3 px-3 py-2"
                }
              >
                <Text className="w-10 text-right font-mono text-sm text-foreground-muted">
                  {index + 1}
                </Text>
                <Text className="flex-1 font-mono text-sm text-foreground">{line || " "}</Text>
              </Pressable>
            </View>
          );
        }}
      />
      <View
        className="gap-3 border-t border-border px-5 pt-4"
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
