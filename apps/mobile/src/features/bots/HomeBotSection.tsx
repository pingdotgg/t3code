import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { memo } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { RowPressable } from "../../components/ui/RowPressable";
import { cn } from "../../lib/cn";
import { ThreadListV2SectionDivider } from "../threads/thread-list-v2-items";
import {
  selectedThreadRowColors,
  THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME,
} from "../threads/thread-list-v2-row-appearance";
import { BotAvatar } from "./BotAvatar";
import { botRowAppearance } from "./bot-row-appearance";
import type { HomeBotRow } from "./homeBots";
import { useBotMachines } from "./new-bot";

type Pane = "screen" | "sidebar";

const AVATAR_SIZE = 26;

const BotRow = memo(function BotRow(props: {
  readonly row: HomeBotRow;
  readonly pane: Pane;
  readonly selected: boolean;
  readonly onSelect: (bot: EnvironmentThreadShell) => void;
}) {
  const gt = useGT();
  const sidebarPane = props.pane === "sidebar";
  const appearance = botRowAppearance(props.pane, props.selected);
  const { bot, status } = props.row;
  const working = status.state === "working" || status.state === "thinking";
  const label =
    status.needsYou > 0
      ? gt("{count, plural, one {Needs you} other {{count} need you}}", {
          count: status.needsYou,
        })
      : status.state === "blocked"
        ? gt("Stopped", { $context: "a Bot's status: it failed and stopped" })
        : working
          ? gt("Working", { $context: "a Bot's status" })
          : null;
  return (
    <RowPressable
      interactionClassName={appearance.interactionClassName}
      interactionOpacity={appearance.interactionOpacity}
      className={appearance.className}
      accessibilityRole="button"
      accessibilityLabel={label === null ? bot.title : `${bot.title}, ${label}`}
      accessibilityState={{ selected: props.selected }}
      onPress={() => props.onSelect(bot)}
    >
      <View
        className={cn(
          THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME,
          "min-h-[44px] flex-row items-center gap-3 py-2",
          sidebarPane && "px-3",
        )}
      >
        <BotAvatar
          threadId={bot.id}
          choice={bot.botConfig?.avatar}
          state={status.state}
          mood={status.mood}
          size={AVATAR_SIZE}
        />
        <Text
          className={cn(
            "min-w-0 flex-1 text-base font-t3-medium",
            props.selected
              ? selectedThreadRowColors.foregroundClassName
              : appearance.foregroundClassName,
          )}
          numberOfLines={1}
        >
          {bot.title}
        </Text>
        {label === null ? null : (
          <Text
            className={cn(
              "shrink-0 text-xs",
              props.selected
                ? selectedThreadRowColors.mutedForegroundClassName
                : status.needsYou > 0
                  ? "font-t3-medium text-warning-foreground"
                  : status.state === "blocked"
                    ? "text-danger-foreground"
                    : appearance.mutedForegroundClassName,
            )}
            numberOfLines={1}
          >
            {label}
          </Text>
        )}
      </View>
    </RowPressable>
  );
});

function NewBotRow(props: { readonly pane: Pane; readonly onPress: () => void }) {
  const gt = useGT();
  const sidebarPane = props.pane === "sidebar";
  const appearance = botRowAppearance(props.pane, false);
  return (
    <RowPressable
      interactionClassName={appearance.interactionClassName}
      className={appearance.className}
      accessibilityRole="button"
      accessibilityLabel={gt("New Bot")}
      onPress={props.onPress}
    >
      <View
        className={cn(
          THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME,
          "min-h-[44px] flex-row items-center gap-3 py-2",
          sidebarPane && "px-3",
        )}
      >
        <View className="items-center justify-center" style={{ width: AVATAR_SIZE }}>
          <SymbolView
            name="plus"
            size={16}
            tintColorClassName={appearance.mutedIconTintClassName}
            type="monochrome"
          />
        </View>
        <Text className={cn("text-base", appearance.mutedForegroundClassName)} numberOfLines={1}>
          {gt("New Bot")}
        </Text>
      </View>
    </RowPressable>
  );
}

/** Bots above the thread list, then a row to start one where a machine can host it. */
export function HomeBotSection(props: {
  readonly rows: ReadonlyArray<HomeBotRow>;
  readonly pane: Pane;
  readonly selectedThreadKey: string | null;
  /** The list's machine filter; a new Bot starts there when it can. */
  readonly environmentId: EnvironmentId | null;
  /** A search lists Bots among its results instead. */
  readonly hidden: boolean;
  readonly onSelectBot: (bot: EnvironmentThreadShell) => void;
  readonly onNewBot: (environmentId: EnvironmentId) => void;
}) {
  const gt = useGT();
  const machines = useBotMachines();
  const newBotEnvironmentId =
    props.environmentId === null
      ? (machines[0]?.environmentId ?? null)
      : machines.some((machine) => machine.environmentId === props.environmentId)
        ? props.environmentId
        : null;
  if (props.hidden || (props.rows.length === 0 && newBotEnvironmentId === null)) return null;
  return (
    <View>
      <ThreadListV2SectionDivider label={gt("Bots")} pane={props.pane} />
      {props.rows.map((row) => (
        <BotRow
          key={row.key}
          row={row}
          pane={props.pane}
          selected={
            props.selectedThreadKey !== null && row.memberKeys.includes(props.selectedThreadKey)
          }
          onSelect={props.onSelectBot}
        />
      ))}
      {newBotEnvironmentId === null ? null : (
        <NewBotRow pane={props.pane} onPress={() => props.onNewBot(newBotEnvironmentId)} />
      )}
    </View>
  );
}
