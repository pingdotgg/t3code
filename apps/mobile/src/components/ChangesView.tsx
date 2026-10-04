import { ScrollView, View } from "react-native";
import { AppText as Text } from "./AppText";
import { changeTone, DiffTokenText, ReviewChangeBar } from "../features/review/reviewDiffRendering";

/** Our diff data, drawn with T3's original review presentation. */
export function ChangesView({ diff }: { diff: string }) {
  if (!diff) return <Text className="text-sm text-foreground-muted">No file changes in this turn.</Text>;
  return <ScrollView horizontal><View>
    {diff.split("\n").map((line, index) => {
      const change = line.startsWith("+") && !line.startsWith("+++") ? "add"
        : line.startsWith("-") && !line.startsWith("---") ? "delete" : "context";
      return <View key={index} className={`flex-row items-center ${changeTone(change)}`}>
        <ReviewChangeBar change={change} />
        <View className="px-2"><DiffTokenText fallback={line} tokens={null} change={change} /></View>
      </View>;
    })}
  </View></ScrollView>;
}
