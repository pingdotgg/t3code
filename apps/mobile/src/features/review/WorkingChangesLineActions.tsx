import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Menu } from "../../components/ui/Menu";

type Props = {
  readonly rangeLabel: string;
  readonly lineCount: number;
  readonly staged: boolean;
  readonly canStage: boolean;
  readonly canRevert: boolean;
  readonly onStage: () => void;
  readonly onRevert?: () => void;
  readonly onComment?: () => void;
  readonly onClear: () => void;
};

/** Comment stays within reach; Git operations share a compact secondary menu. */
export function WorkingChangesLineActions(props: Props) {
  const noun = props.lineCount === 1 ? "line" : "lines";
  const stageLabel = `${props.staged ? "Unstage" : "Stage"} ${noun}`;
  const actions = [
    {
      id: "stage",
      title: stageLabel,
      image: props.staged ? "minus" : "plus",
      attributes: { disabled: !props.canStage },
    },
    ...(props.onRevert
      ? [
          {
            id: "revert",
            title: `Revert ${noun}`,
            image: "arrow.uturn.backward",
            attributes: { disabled: !props.canRevert, destructive: true },
          },
        ]
      : []),
  ];
  return (
    <View className="gap-1 border-t border-border-subtle bg-card px-3 pb-2 pt-1">
      <View className="flex-row items-center">
        <Text className="min-w-0 flex-1 text-xs text-foreground-muted">
          {props.lineCount === 1 ? "Line" : "Lines"} {props.rangeLabel} selected
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Clear line selection"
          onPress={props.onClear}
          className="size-11 items-center justify-center"
        >
          <SymbolView name="xmark" size={16} tintColorClassName="accent-icon" />
        </Pressable>
      </View>
      <View className="flex-row items-center gap-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Comment on selected lines"
          accessibilityState={{ disabled: !props.onComment }}
          disabled={!props.onComment}
          onPress={props.onComment}
          className={`min-h-11 min-w-0 flex-1 flex-row items-center justify-center gap-2 rounded-lg px-3 ${props.onComment ? "bg-primary" : "bg-subtle"}`}
        >
          <SymbolView
            name="text.bubble"
            size={16}
            tintColorClassName={props.onComment ? "accent-primary-foreground" : "accent-icon-muted"}
          />
          <Text
            className={`text-sm font-t3-medium ${props.onComment ? "text-primary-foreground" : "text-foreground-muted"}`}
          >
            Comment
          </Text>
        </Pressable>
        <Menu
          title="Selected line actions"
          actions={actions}
          onPressAction={({ nativeEvent }) => {
            if (nativeEvent.event === "stage" && props.canStage) props.onStage();
            if (nativeEvent.event === "revert" && props.canRevert) props.onRevert?.();
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Selected line actions"
            className="min-h-11 flex-row items-center justify-center gap-2 rounded-lg border border-border-subtle px-3"
          >
            <Text className="text-sm font-t3-medium">More</Text>
            <SymbolView name="ellipsis" size={16} tintColorClassName="accent-icon" />
          </Pressable>
        </Menu>
      </View>
    </View>
  );
}
