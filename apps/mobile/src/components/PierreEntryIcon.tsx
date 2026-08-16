import { SymbolView } from "../components/AppSymbol";
import { Image, type ImageStyle, type StyleProp } from "react-native";

import { markdownFileIconSource } from "@t3tools/mobile-markdown-text/file-icons";
import { resolveMarkdownFileIcon } from "@t3tools/mobile-markdown-text/links";
import { useThemeColor } from "../lib/useThemeColor";

export function PierreEntryIcon(props: {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly size?: number;
  readonly style?: StyleProp<ImageStyle>;
}) {
  const size = props.size ?? 16;
  const folderColor = useThemeColor("--color-icon-subtle");
  if (props.kind === "directory") {
    return <SymbolView name="folder" size={size} tintColor={folderColor} type="monochrome" />;
  }

  return (
    <Image
      source={markdownFileIconSource(resolveMarkdownFileIcon(props.path))}
      resizeMode="contain"
      style={[{ width: size, height: size }, props.style]}
    />
  );
}
