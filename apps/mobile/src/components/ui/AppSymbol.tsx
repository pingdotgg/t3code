import type { SFSymbol } from "expo-symbols";
import { SymbolView as ExpoSymbolView } from "expo-symbols";
import { withUniwind } from "uniwind";
import connSymbols from "../../../modules/conn-symbols/symbols.json";
import type { AppSymbolViewProps } from "./AppSymbol.android";
import { useConnSymbolScope } from "../ConnSymbolScope";

export type { SFSymbol } from "expo-symbols";
export type { AppSymbolName, AppSymbolViewProps } from "./AppSymbol.android";

// Conn: every name goes through expo-symbols, git and diff names included.
// Inside a ConnSymbolScope, mapped names get a `conn.` prefix and resolve to
// Conn's Phosphor symbol; elsewhere they stay SF Symbols.
// App names that are not SF Symbols and have no Conn symbol yet.
const SF_FALLBACKS: Readonly<Record<string, string>> = {
  "git.issue": "smallcircle.filled.circle",
};

function AppSymbolView(props: AppSymbolViewProps) {
  const scoped = useConnSymbolScope();
  const name = typeof props.name === "string" ? props.name : props.name.ios;
  const resolved =
    scoped && Object.hasOwn(connSymbols, name) ? `conn.${name}` : (SF_FALLBACKS[name] ?? name);
  return <ExpoSymbolView {...props} name={resolved as SFSymbol} />;
}

export const SymbolView = withUniwind(AppSymbolView);
