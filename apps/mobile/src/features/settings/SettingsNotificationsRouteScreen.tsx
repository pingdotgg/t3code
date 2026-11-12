import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { AppText as Text } from "../../components/ui/AppText";
import { SettingsScreen } from "./components/SettingsScreen";

export function SettingsNotificationsRouteScreen() {
  return (
    <SettingsScreen title="Notifications">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-3 px-5 pt-4"
      >
        <Text className="text-base text-foreground">
          Push notifications and Live Activities are not available in this app.
        </Text>
        <Text className="text-sm leading-normal text-foreground-muted">
          They were delivered through T3 Connect, which this build does not include. Open the app to
          see what your agents are doing.
        </Text>
      </ScrollView>
    </SettingsScreen>
  );
}
