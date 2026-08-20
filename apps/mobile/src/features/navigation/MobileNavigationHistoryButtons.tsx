import { View } from "react-native";

import { ControlPill } from "../../components/ControlPill";
import { useMobileNavigationHistory } from "./MobileNavigationHistoryProvider";

export function MobileNavigationHistoryButtons({
  grouped = false,
}: {
  readonly grouped?: boolean;
}) {
  const history = useMobileNavigationHistory();
  const groupedClassName = grouped ? "bg-transparent" : undefined;

  return (
    <View className="flex-row items-center gap-0.5">
      <ControlPill
        accessibilityLabel="Back"
        {...(groupedClassName ? { className: groupedClassName } : {})}
        disabled={!history.canGoBack}
        icon="chevron.left"
        onPress={history.back}
      />
      <ControlPill
        accessibilityLabel="Forward"
        {...(groupedClassName ? { className: groupedClassName } : {})}
        disabled={!history.canGoForward}
        icon="chevron.right"
        onPress={history.forward}
      />
    </View>
  );
}
