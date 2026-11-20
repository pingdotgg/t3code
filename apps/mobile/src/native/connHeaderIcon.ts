import type { NativeStackHeaderItem } from "@react-navigation/native-stack";
import type { ImageSourcePropType } from "react-native";
import { CONN_HEADER_ICON_BY_SF_NAME } from "./connHeaderIcons.generated";

type NativeHeaderIcon = NonNullable<Extract<NativeStackHeaderItem, { type: "button" }>["icon"]>;

/**
 * A native header button icon by SF Symbol name: the icon set's 24px template image when it maps
 * the name, so header buttons draw Conn's glyphs at their own size; the SF Symbol otherwise.
 */
export function connHeaderIcon(name: string): NativeHeaderIcon {
  const source = CONN_HEADER_ICON_BY_SF_NAME[name];
  return source === undefined
    ? { type: "sfSymbol", name: name as never }
    : { type: "image", source, tinted: true };
}

/** The same, in react-native-screens' header item format (screens-level headers such as sheets). */
export function connScreensHeaderIcon(
  name: string,
):
  | { type: "templateSource"; templateSource: ImageSourcePropType }
  | { type: "sfSymbol"; name: string } {
  const source = CONN_HEADER_ICON_BY_SF_NAME[name];
  return source === undefined
    ? { type: "sfSymbol", name }
    : { type: "templateSource", templateSource: source };
}
