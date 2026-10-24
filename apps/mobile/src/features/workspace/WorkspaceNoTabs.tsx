import { useNavigation } from "@react-navigation/native";
import { View } from "react-native";
import { EmptyState } from "../../components/ui/EmptyState";

export function WorkspaceNoTabs() {
  const navigation = useNavigation();
  return (
    <View className="flex-1 items-center justify-center bg-screen">
      <EmptyState
        title="All sections are hidden"
        detail="Show a section to add it back to navigation."
        actionLabel="Edit navigation tabs"
        variant="plain"
        onAction={() =>
          navigation.navigate("SettingsSheet", {
            screen: "SettingsContent",
            params: { screen: "SettingsNavigation", initial: false },
          })
        }
      />
    </View>
  );
}
