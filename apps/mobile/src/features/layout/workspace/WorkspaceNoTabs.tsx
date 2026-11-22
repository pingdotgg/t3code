import { useNavigation } from "@react-navigation/native";
import { useGT } from "gt-react-native";
import { View } from "react-native";
import { EmptyState } from "../../../components/ui/EmptyState";
import { openSettings } from "../../settings/settings-navigation";

export function WorkspaceNoTabs() {
  const gt = useGT();
  const navigation = useNavigation();
  return (
    <View className="flex-1 items-center justify-center bg-screen">
      <EmptyState
        title={gt("All sections are hidden")}
        detail={gt("Show a section to add it back to navigation.")}
        actionLabel={gt("Edit navigation tabs")}
        variant="plain"
        onAction={() => openSettings(navigation, "SettingsNavigation")}
      />
    </View>
  );
}
