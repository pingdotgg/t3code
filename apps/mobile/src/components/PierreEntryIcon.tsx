import { SymbolView } from "../components/AppSymbol";
import { Image, type ImageStyle, type StyleProp } from "react-native";

import { markdownFileIconSource } from "../lib/markdownFileIcons";
import { resolveMarkdownFileIcon } from "../lib/markdownLinks";

export function PierreEntryIcon(props: {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly size?: number;
  readonly style?: StyleProp<ImageStyle>;
}) {
  const size = props.size ?? 16;
  if (props.kind === "directory") {
    return (
      <SymbolView
        name="folder"
        size={size}
        tintColorClassName={"accent-icon-subtle"}
        type="monochrome"
      />
    );
  }

  return (
    <Image
      source={markdownFileIconSource(resolveMarkdownFileIcon(props.path))}
      resizeMode="contain"
      style={[{ width: size, height: size }, props.style]}
    />
  );
}
