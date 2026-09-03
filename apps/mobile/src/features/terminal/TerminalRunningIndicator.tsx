import { View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { StatusPulse } from "../../components/StatusPulse";
import { TERMINAL_RUNNING_ACCESSIBILITY_LABEL } from "./terminalRunningStatus";

export function TerminalRunningIndicator(props: {
  readonly selected?: boolean;
  readonly size?: number;
}) {
  return (
    <View accessibilityLabel={TERMINAL_RUNNING_ACCESSIBILITY_LABEL} accessibilityRole="image">
      <StatusPulse active minimumOpacity={props.selected ? 0.6 : undefined}>
        <SymbolView
          name="terminal"
          size={props.size ?? 13}
          tintColorClassName={
            props.selected ? "accent-user-bubble-foreground" : "accent-terminal-active"
          }
          type="monochrome"
        />
      </StatusPulse>
    </View>
  );
}
