import {
  formatAdditionCharacters,
  type AgentAdditionChip,
  type AgentAdditionGroup,
  type AgentAdditionsSummary,
} from "@t3tools/client-runtime/work-log/agent-additions";
import { useGT } from "gt-react-native";
import type { ReactNode } from "react";
import { Pressable, View, type ColorValue } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { cn } from "../../lib/cn";
import type { AgentAdditionActivity, ThreadFeedActivity } from "../../lib/threadActivity";
import { ThreadDisclosureChevron } from "./thread-work-log";

const signedCount = (characters: number) =>
  `${characters < 0 ? "−" : characters > 0 ? "+" : ""}${Math.abs(characters).toLocaleString()}`;

/** One closed-by-default panel for adjacent rows that reached, or were kept from, the agent. */
export function ThreadAgentAdditionsPanel(props: {
  readonly summary: AgentAdditionsSummary<AgentAdditionActivity>;
  readonly expanded: boolean;
  readonly viewing: Readonly<Record<string, boolean>>;
  readonly iconColor: ColorValue;
  readonly onToggle: () => void;
  readonly onToggleView: (activity: ThreadFeedActivity) => void;
  /** Today's row for one activity, which shows its exact text. */
  readonly renderDetail: (activity: ThreadFeedActivity) => ReactNode;
}) {
  const gt = useGT();
  const chipLabels: Record<AgentAdditionChip["kind"], (value: number) => string> = {
    harness: (value) =>
      gt("Claude Code {characters}", { characters: formatAdditionCharacters(value) }),
    t3: (value) => gt("T3 Code {characters}", { characters: formatAdditionCharacters(value) }),
    rules: (value) =>
      gt("Your rules {characters}", { characters: formatAdditionCharacters(value) }),
    held: (value) => gt("{count} held back", { count: value }),
    blocked: (value) => gt("{count} blocked", { count: value }),
    failed: (value) => gt("{count} failed", { count: value }),
  };
  const groupTitles: Record<AgentAdditionGroup, string> = {
    harness: gt("Added by Claude Code"),
    t3: gt("Added by T3 Code"),
    rules: gt("Changed by your rules"),
    held: gt("Held back by your settings"),
    blocked: gt("Blocked"),
  };
  const title = gt("What reached the agent");

  return (
    <View className="mb-2 rounded-xl border border-border">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={{ expanded: props.expanded }}
        className="min-h-11 flex-row items-center gap-2 px-3 py-2"
        onPress={props.onToggle}
      >
        <SymbolView name="text.alignleft" size={14} tintColor={props.iconColor} />
        <View className="flex-1 flex-row flex-wrap items-center gap-1.5">
          <Text textRole="footnote" className="font-t3-medium text-foreground">
            {title}
          </Text>
          {props.summary.chips.map((chip) => (
            <View
              key={chip.kind}
              className={cn(
                "rounded-md px-1.5 py-0.5",
                chip.kind === "blocked" || chip.kind === "failed" ? "bg-warning" : "bg-subtle",
              )}
            >
              <Text
                textRole="caption"
                className={
                  chip.kind === "blocked" || chip.kind === "failed"
                    ? "text-warning-foreground"
                    : "text-foreground-secondary"
                }
              >
                {chipLabels[chip.kind](chip.value)}
              </Text>
            </View>
          ))}
        </View>
        <ThreadDisclosureChevron
          expanded={props.expanded}
          collapsedDirection="down"
          size={12}
          tintColor={props.iconColor}
        />
      </Pressable>
      {props.expanded ? (
        <View className="gap-3 border-t border-border px-3 pt-2 pb-3">
          {props.summary.groups.map(({ group, rows }) => (
            <View key={group}>
              <Text
                textRole="caption"
                className={cn(
                  "mb-1 font-t3-medium uppercase",
                  group === "blocked" ? "text-warning-foreground" : "text-foreground-muted",
                )}
              >
                {groupTitles[group]}
              </Text>
              {rows.map(({ item, activity }) => {
                const warn = group === "blocked" || item.outcome === "failed";
                const lines = item.addition.items ?? [
                  { label: item.summary, note: undefined, characters: item.addition.characters },
                ];
                return (
                  <View key={item.id}>
                    {lines.map((line, index) => (
                      <View
                        key={`${line.label}:${line.note}:${line.characters}`}
                        className="min-h-7 flex-row items-baseline gap-3 py-1"
                      >
                        <Text
                          textRole="footnote"
                          className={cn(
                            "flex-1",
                            warn ? "text-warning-foreground" : "text-foreground",
                          )}
                        >
                          {line.label}
                          {line.note ? (
                            <Text className="text-foreground-muted"> · {line.note}</Text>
                          ) : null}
                        </Text>
                        <Text
                          textRole="caption"
                          className="w-16 text-right tabular-nums text-foreground-muted"
                        >
                          {line.characters === undefined
                            ? ""
                            : group === "rules"
                              ? signedCount(line.characters)
                              : line.characters.toLocaleString()}
                        </Text>
                        <View className="w-12 items-end">
                          {index === 0 && activity.canExpand ? (
                            <Pressable
                              accessibilityRole="button"
                              hitSlop={8}
                              onPress={() => props.onToggleView(activity)}
                            >
                              <Text textRole="caption" className="text-foreground-secondary">
                                {props.viewing[activity.id] ? gt("Hide") : gt("View")}
                              </Text>
                            </Pressable>
                          ) : null}
                        </View>
                      </View>
                    ))}
                    {props.viewing[activity.id] ? props.renderDetail(activity) : null}
                  </View>
                );
              })}
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}
