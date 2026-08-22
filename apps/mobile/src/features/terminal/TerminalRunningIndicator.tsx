import { View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { StatusPulse } from "../../components/StatusPulse";
import { useThemeColor } from "../../lib/useThemeColor";
import { terminalRunningSessionLabel } from "./terminalRunningStatus";

export function TerminalRunningIndicator(props: {
  readonly sessionCount: number;
  readonly size?: number;
}) {
  const activeColor = useThemeColor("--color-terminal-active");
  const accessibilityLabel = terminalRunningSessionLabel(props.sessionCount);

  if (accessibilityLabel === null) {
    return null;
  }

  return (
    <View accessibilityLabel={accessibilityLabel} accessibilityRole="image">
      <StatusPulse active>
        <SymbolView
          name="terminal"
          size={props.size ?? 13}
          tintColor={activeColor}
          type="monochrome"
        />
      </StatusPulse>
    </View>
  );
}
