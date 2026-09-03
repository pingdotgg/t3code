import IconTerminal2 from "@tabler/icons-react-native/IconTerminal2";
import { SymbolView as ExpoSymbolView, type SymbolViewProps } from "expo-symbols";
import type { ComponentProps } from "react";
import { withUniwind } from "uniwind";

export type { SFSymbol } from "expo-symbols";
export type AppSymbolName = SymbolViewProps["name"];

/**
 * Keep the iOS implementation isolated from the Android Tabler fallback so
 * Metro does not initialize the icon package when iOS renders SF Symbols.
 */
function AppSymbolView(props: SymbolViewProps) {
  const symbolName = typeof props.name === "string" ? props.name : props.name.ios;
  if (symbolName === "terminal") {
    const terminalIconProps = {
      accessibilityLabel: props.accessibilityLabel,
      color: props.tintColor,
      size: props.size,
      strokeWidth: 2,
      style: props.style,
      testID: props.testID,
    } as ComponentProps<typeof IconTerminal2>;
    return <IconTerminal2 {...terminalIconProps} />;
  }
  return <ExpoSymbolView {...props} />;
}

export const SymbolView = withUniwind(AppSymbolView);
