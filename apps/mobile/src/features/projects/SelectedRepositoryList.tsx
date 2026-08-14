import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";

export function SelectedRepositoryList(props: {
  readonly repoRoots: ReadonlyArray<string>;
  readonly onRemove: (repoRoot: string) => void;
}) {
  if (props.repoRoots.length === 0) return null;
  return (
    <View className="gap-2 rounded-2xl bg-card px-4 py-3">
      {props.repoRoots.map((root, index) => (
        <View key={root} className="flex-row items-center gap-2">
          <Text className="flex-1 text-sm" numberOfLines={1}>
            {root}
          </Text>
          <Text className="text-xs text-foreground-muted">
            {index === 0 ? "Primary" : "Attached"}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Remove ${root}`}
            onPress={() => props.onRemove(root)}
            className="rounded-full px-2 py-1 active:opacity-60"
          >
            <Text className="text-xs font-t3-bold text-primary">Remove</Text>
          </Pressable>
        </View>
      ))}
    </View>
  );
}
