// Custom build: next-prompt suggestion buttons above the composer.
import { isNextPromptInDraft } from "@t3tools/client-runtime/next-prompt-draft";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type {
  EnvironmentId,
  OrchestrationV2NextPromptCommand,
  RunId,
  ServerProvider,
} from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import Animated, { FadeIn, ReduceMotion } from "react-native-reanimated";

import { AppText } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import {
  buildNextPromptChips,
  nextPromptCommandsToFreeze,
  type NextPromptChip,
} from "./nextPromptChips";

/**
 * Next prompts for the thread's latest completed run: the reply's own `options` lines, or with
 * the Labs switch on, the ones a small model picks, which may name a skill or command.
 */
export function useNextPromptChips(input: {
  readonly environmentId: EnvironmentId;
  readonly thread: EnvironmentThreadShell | null;
  /** The Labs "Suggest next prompt" switch. */
  readonly enabled: boolean;
  readonly provider: ServerProvider | null;
  /** False until the server config arrives; the command list waits for it. */
  readonly configLoaded: boolean;
}): ReadonlyArray<NextPromptChip> {
  const { environmentId, thread } = input;
  const latestRun = thread?.latestRun ?? null;
  const completedRunId = latestRun?.status === "completed" ? latestRun.runId : null;

  // Freeze the command list per run: a workspace rescan must not ask the model again. It waits
  // for the server config, since the server caches what it gets first for the run.
  const [frozen, setFrozen] = useState<{
    readonly runId: RunId;
    readonly commands: ReadonlyArray<OrchestrationV2NextPromptCommand>;
  } | null>(null);
  const commandsToFreeze =
    completedRunId !== null && frozen?.runId !== completedRunId
      ? nextPromptCommandsToFreeze({ configLoaded: input.configLoaded, provider: input.provider })
      : null;
  if (completedRunId !== null && commandsToFreeze !== null) {
    setFrozen({ runId: completedRunId, commands: commandsToFreeze });
  }
  const commands = frozen !== null && frozen.runId === completedRunId ? frozen.commands : null;

  const { data } = useEnvironmentQuery(
    // Asked even with the Labs switch off: a reply's own `options` block needs no model.
    thread !== null && completedRunId !== null && commands !== null
      ? orchestrationEnvironment.v2.nextPromptSuggestions({
          environmentId,
          input: { threadId: thread.id, runId: completedRunId, commands },
        })
      : null,
  );
  // The provider's own predicted next prompt, as the desktop's grey suggestion shows it.
  const { data: predicted } = useEnvironmentQuery(
    input.enabled && thread !== null && completedRunId !== null
      ? orchestrationEnvironment.v2.promptSuggestion({
          environmentId,
          input: { threadId: thread.id },
        })
      : null,
  );
  const builtInSuggestion =
    predicted !== null && predicted !== undefined && predicted.runId === completedRunId
      ? predicted.text
      : null;
  return buildNextPromptChips({ enabled: input.enabled, completedRunId, data, builtInSuggestion });
}

// Typical options are 6-8 words, which the shared Chip's one 180 px line cuts to look-alike
// stubs, so these buttons get up to three quarters of the row and two lines.
const CHIP_MAX_WIDTH_SHARE = 0.75;
const ROW_GUTTER = 12;

/**
 * A row of buttons directly above the composer. It sits inside the composer's measured
 * layout, so the feed leaves room for it instead of being covered.
 */
export function NextPromptSuggestionChips(props: {
  readonly chips: ReadonlyArray<NextPromptChip>;
  /** The composer text, to mark the chips already added to it. */
  readonly draft: string;
  readonly onPick: (chip: NextPromptChip) => void;
}) {
  const windowSize = useWindowDimensions();
  // The row's own width (a split-screen or wide layout is narrower than the window).
  const [rowWidth, setRowWidth] = useState<number | null>(null);
  if (props.chips.length === 0) return null;
  const chipMaxWidth = Math.round(
    ((rowWidth ?? windowSize.width) - ROW_GUTTER * 2) * CHIP_MAX_WIDTH_SHARE,
  );
  return (
    <Animated.View
      entering={FadeIn.duration(160).reduceMotion(ReduceMotion.System)}
      className="-mx-[12px] pb-2"
      onLayout={(event) => setRowWidth(event.nativeEvent.layout.width)}
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="always"
        contentContainerClassName="items-center gap-1.5 px-[12px]"
      >
        {props.chips.map((chip) => {
          const selected = isNextPromptInDraft(props.draft, chip.insertText);
          // Skills and commands look like code, as on desktop: monospace with a primary border.
          const isCommand = chip.kind !== "prompt";
          return (
            <Pressable
              key={`${chip.kind}:${chip.label}`}
              accessibilityRole="button"
              accessibilityLabel={chip.label}
              accessibilityHint={
                selected ? "Takes it out of your message" : "Adds it to your message"
              }
              accessibilityState={{ selected }}
              onPress={() => props.onPick(chip)}
              hitSlop={6}
              className="active:opacity-70"
            >
              <View
                style={{ maxWidth: chipMaxWidth }}
                className={cn(
                  "min-h-8 justify-center rounded-2xl px-3 py-1.5",
                  selected ? "bg-primary" : "bg-subtle",
                  isCommand && "border border-primary/60",
                )}
              >
                <AppText
                  textRole="footnote"
                  numberOfLines={2}
                  className={cn(
                    isCommand ? "font-mono" : "font-t3-medium",
                    selected ? "text-primary-foreground" : "text-foreground-muted",
                  )}
                >
                  {chip.label}
                </AppText>
              </View>
            </Pressable>
          );
        })}
      </ScrollView>
    </Animated.View>
  );
}
