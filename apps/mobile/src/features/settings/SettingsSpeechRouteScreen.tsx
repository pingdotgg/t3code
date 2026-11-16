import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useEnvironments } from "../../state/environments";
import { SettingsScreen } from "./components/SettingsScreen";
import { SpeechOutputSettings } from "./SpeechOutputSettings";

export function SettingsSpeechRouteScreen() {
  const insets = useSafeAreaInsets();
  const { environments } = useEnvironments();
  return (
    <SettingsScreen title="Speech">
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-3 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SpeechOutputSettings environments={environments} />
      </ScreenScrollView>
    </SettingsScreen>
  );
}
