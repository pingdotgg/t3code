// Mobile UI lab: draws the new icon set (superheroicons 16px solid) with react-native-svg, keeping
// the size, colour and style each call site passes. Only imported when CONN_ICON_LAB=1.
import { memo } from "react";
import {
  PlatformColor as nativePlatformColor,
  View,
  type ColorValue,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { SvgXml } from "react-native-svg";
import { CONCEPT_SVG } from "./iconSet.generated";

// The set's glyphs fill about 75% of the 16px box; SF Symbols and Tabler fill more of their size.
const OPTICAL_SCALE = 1.12;

export interface LabGlyphProps {
  readonly concept: string;
  readonly size?: number | undefined;
  readonly color?: ColorValue | undefined;
  readonly style?: StyleProp<ViewStyle>;
  readonly accessibilityLabel?: string | undefined;
  readonly testID?: string | undefined;
}

export const LabGlyph = memo(function LabGlyph(props: LabGlyphProps) {
  const xml = CONCEPT_SVG[props.concept];
  if (xml === undefined) return null;
  const size = props.size ?? 24;
  const drawn = Math.round(size * OPTICAL_SCALE * 100) / 100;
  return (
    <View
      accessibilityLabel={props.accessibilityLabel}
      accessible={props.accessibilityLabel !== undefined}
      testID={props.testID}
      style={[
        { width: size, height: size, alignItems: "center", justifyContent: "center" },
        props.style,
      ]}
    >
      <SvgXml
        xml={xml}
        width={drawn}
        height={drawn}
        color={props.color ?? nativePlatformColor("label")}
        style={{ flexShrink: 0 }}
      />
    </View>
  );
});

/** A stand-in for a Tabler icon component: keeps size, color and style, ignores stroke props. */
export function createTablerIcon(concept: string) {
  function LabTablerIcon(props: {
    readonly size?: number | string;
    readonly color?: ColorValue;
    readonly style?: StyleProp<ViewStyle>;
    readonly accessibilityLabel?: string;
    readonly testID?: string;
    readonly [key: string]: unknown;
  }) {
    const size = typeof props.size === "string" ? Number.parseFloat(props.size) : props.size;
    return (
      <LabGlyph
        concept={concept}
        size={size ?? 24}
        color={props.color}
        style={props.style}
        accessibilityLabel={props.accessibilityLabel}
        testID={props.testID}
      />
    );
  }
  LabTablerIcon.displayName = `LabTablerIcon(${concept})`;
  return LabTablerIcon;
}
