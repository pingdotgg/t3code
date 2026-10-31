import { useNavigation } from "@react-navigation/native";
import { View } from "react-native";
import { EmptyState } from "../../components/ui/EmptyState";
import { openSettings } from "../settings/settings-navigation";

export function WorkspaceNoTabs() {
  const navigation = useNavigation();
  return (
    <View className="flex-1 items-center justify-center bg-screen">
      <EmptyState
        title="All sections are hidden"
        detail="Show a section to add it back to navigation."
        actionLabel="Edit navigation tabs"
        variant="plain"
        onAction={() => openSettings(navigation, "SettingsNavigation")}
      />
    </View>
  );
}
