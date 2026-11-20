import type { SFSymbol } from "expo-symbols";
import { SymbolView as ExpoSymbolView } from "expo-symbols";
import { withUniwind } from "uniwind";
import type { AppSymbolViewProps } from "./AppSymbol.android";

export type { SFSymbol } from "expo-symbols";
export type { AppSymbolName, AppSymbolViewProps } from "./AppSymbol.android";

// Conn: every name goes through expo-symbols. ConnSymbols.swift answers the SF names the
// icon set maps with its glyphs, native toolbars and menus included.

function AppSymbolView(props: AppSymbolViewProps) {
  const name = typeof props.name === "string" ? props.name : props.name.ios;
  return <ExpoSymbolView {...props} name={name as SFSymbol} />;
}

export const SymbolView = withUniwind(AppSymbolView);
