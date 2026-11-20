// Lab stand-in for `expo-symbols` (metro.config.js aliases it when CONN_ICON_LAB=1). SF Symbol
// names the icon set covers draw as SVG; the rest fall through to the real SymbolView.
import { SymbolView as RealSymbolView, type SymbolViewProps } from "expo-symbols";
import { SF_EXTRA_TO_CONCEPT } from "./iconMap";
import { SF_TO_CONCEPT } from "./iconSet.generated";
import { LabGlyph } from "./LabIcon";

export { unstable_getMaterialSymbolSourceAsync } from "expo-symbols";
export type * from "expo-symbols";

function conceptFor(name: SymbolViewProps["name"]): string | undefined {
  const sfName = typeof name === "string" ? name : name.ios;
  if (sfName === undefined) return undefined;
  // Inside a ConnSymbolScope AppSymbol prefixes mapped names with `conn.`.
  const base = sfName.startsWith("conn.") ? sfName.slice(5) : sfName;
  return SF_TO_CONCEPT[base] ?? SF_EXTRA_TO_CONCEPT[base];
}

export function SymbolView(props: SymbolViewProps) {
  const concept = conceptFor(props.name);
  if (concept === undefined) return <RealSymbolView {...props} />;
  return (
    <LabGlyph
      concept={concept}
      size={props.size}
      color={props.tintColor}
      style={props.style}
      accessibilityLabel={props.accessibilityLabel}
      testID={props.testID}
    />
  );
}
