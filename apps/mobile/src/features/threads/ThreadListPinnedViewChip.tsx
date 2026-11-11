import { View } from "react-native";

import { Chip } from "../../components/ui/Chip";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

/** Pinned view beta: switches the thread list between the inbox and pinned threads. */
export function ThreadListPinnedViewChip(props: {
  readonly threadView: "active" | "pinned" | null;
  readonly otherViewThreadCount: number;
  readonly otherViewDoneCount: number;
  readonly onToggle: () => void;
}) {
  const { themeAppearance } = useAppearancePreferences();
  if (props.threadView === null) return null;
  const otherViewName = props.threadView === "pinned" ? "active" : "pinned";
  const done = props.otherViewDoneCount > 0 ? ` · ${props.otherViewDoneCount} done` : "";
  return (
    <View className="flex-row px-4 pb-2">
      <Chip
        icon="pin"
        label={`Show ${otherViewName} (${props.otherViewThreadCount})${done}`}
        accessibilityLabel={`Show ${otherViewName} threads, ${props.otherViewThreadCount} ${otherViewName} ${props.otherViewThreadCount === 1 ? "thread" : "threads"}, ${props.otherViewDoneCount} unread done`}
        selected={props.threadView === "pinned"}
        size="small"
        glass
        colorScheme={themeAppearance}
        onPress={props.onToggle}
      />
    </View>
  );
}
