import { SymbolView as ExpoSymbolView } from "expo-symbols";
import { withUniwind } from "uniwind";
import type { AppSymbolViewProps } from "./AppSymbol";

export type { SFSymbol } from "expo-symbols";
export type { AppSymbolName } from "./AppSymbol";

/**
 * Keep the iOS implementation isolated from the Android Tabler fallback so
 * Metro does not initialize the icon package when iOS renders SF Symbols.
 */
function AppSymbolView(props: AppSymbolViewProps) {
  return <ExpoSymbolView {...props} />;
}

export const SymbolView = withUniwind(AppSymbolView);
