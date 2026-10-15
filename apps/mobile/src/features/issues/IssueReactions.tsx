import type { IssueReaction, IssueReactionContent } from "@t3tools/contracts";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ControlPillMenu } from "../../components/ControlPillMenu";
import { cn } from "../../lib/cn";
import { ISSUE_REACTIONS, issueReactionOptions } from "./issueDetail";

export function IssueReactions(props: {
  readonly reactions: ReadonlyArray<IssueReaction> | undefined;
  readonly busy?: boolean;
  readonly contents?: ReadonlyArray<IssueReactionContent>;
  readonly onToggle?: (content: IssueReactionContent, reacted: boolean) => void;
}) {
  const { onToggle } = props;
  const reactions = props.reactions ?? [];
  const options = issueReactionOptions(props.contents);
  const toggle = (content: IssueReactionContent, reacted: boolean) => {
    if (props.busy || !options.some((item) => item.content === content)) return;
    onToggle?.(content, reacted);
  };
  if (!reactions.length && (!onToggle || options.length === 0)) return null;
  return (
    <View className="flex-row flex-wrap items-center gap-1.5">
      {reactions.map((reaction) => {
        const presentation = ISSUE_REACTIONS.find((item) => item.content === reaction.content);
        const canToggle = !!onToggle && options.some((item) => item.content === reaction.content);
        return (
          <Pressable
            key={reaction.content}
            accessibilityRole={canToggle ? "button" : undefined}
            accessibilityLabel={`${presentation?.label ?? reaction.content}, ${reaction.count}${reaction.viewerHasReacted ? ", including you" : ""}`}
            accessibilityState={{
              selected: reaction.viewerHasReacted,
              disabled: !canToggle || props.busy,
            }}
            disabled={!canToggle || props.busy}
            onPress={() => toggle(reaction.content, !reaction.viewerHasReacted)}
            className={cn(
              "min-h-7 flex-row items-center gap-1 rounded-full px-2.5 active:opacity-70",
              reaction.viewerHasReacted ? "bg-subtle-strong" : "bg-subtle",
            )}
          >
            <Text className="text-xs">{presentation?.emoji ?? reaction.content}</Text>
            <Text className="text-2xs tabular-nums text-foreground-muted">{reaction.count}</Text>
          </Pressable>
        );
      })}
      {onToggle && options.length > 0 ? (
        <ControlPillMenu
          title="Add reaction"
          actions={options.map((item) => ({
            id: item.content,
            title: `${item.emoji} ${item.label}`,
            state: reactions.some(
              (reaction) => reaction.content === item.content && reaction.viewerHasReacted,
            )
              ? ("on" as const)
              : ("off" as const),
          }))}
          onPressAction={({ nativeEvent }) => {
            const item = options.find((each) => each.content === nativeEvent.event);
            if (!item || props.busy) return;
            toggle(
              item.content,
              !reactions.some(
                (reaction) => reaction.content === item.content && reaction.viewerHasReacted,
              ),
            );
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Add reaction"
            disabled={props.busy}
            hitSlop={6}
            className="h-7 w-9 items-center justify-center rounded-full bg-subtle active:opacity-70"
          >
            <SymbolView name="plus" size={13} tintColorClassName="accent-icon-muted" />
          </Pressable>
        </ControlPillMenu>
      ) : null}
    </View>
  );
}
