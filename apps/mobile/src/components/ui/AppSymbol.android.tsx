import type { AndroidSymbol, SymbolViewProps } from "expo-symbols";
import { StyleSheet, View } from "react-native";
import { withUniwind } from "uniwind";
import { ConnGlyph } from "./ConnGlyph";
import { CONN_GLYPH_BY_SF_NAME } from "./connGlyphs.generated";

// Conn: Android draws the same Superheroicons glyphs as iOS, by SF Symbol name (the icon
// set's manifest). In `{ ios, android }` pairs the iOS name picks the glyph.
type ConnSymbolName = keyof typeof CONN_GLYPH_BY_SF_NAME;

export type { SFSymbol } from "expo-symbols";
export type AppSymbolName =
  | ConnSymbolName
  | {
      ios: ConnSymbolName;
      android: AndroidSymbol;
    };

export type AppSymbolViewProps = Omit<SymbolViewProps, "name"> & { name: AppSymbolName };

export function isAppSymbolName(name: string): name is ConnSymbolName {
  return Object.hasOwn(CONN_GLYPH_BY_SF_NAME, name);
}

function AppSymbolView(props: AppSymbolViewProps) {
  const name = typeof props.name === "string" ? props.name : props.name.ios;
  const glyph = isAppSymbolName(name) ? CONN_GLYPH_BY_SF_NAME[name] : undefined;
  if (!glyph) {
    return props.fallback ?? null;
  }

  // react-native-svg applies style.transform to its inner path around (0,0), so a
  // rotated icon draws outside its box. Transform a wrapping View instead.
  const transformed = StyleSheet.flatten(props.style)?.transform !== undefined;
  const icon = (
    <ConnGlyph
      glyph={glyph}
      accessibilityLabel={props.accessibilityLabel}
      color={props.tintColor ?? undefined}
      size={props.size}
      style={transformed ? undefined : props.style}
      testID={props.testID}
    />
  );
  return transformed ? <View style={props.style}>{icon}</View> : icon;
}

export const SymbolView = withUniwind(AppSymbolView);
