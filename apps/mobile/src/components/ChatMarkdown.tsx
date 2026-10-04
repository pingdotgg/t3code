import { Linking, useColorScheme } from "react-native";
import { SelectableMarkdownText, type MarkdownCodeHighlighter, type NativeMarkdownTextStyle } from "@t3mobile/markdown";
import variables from "../../generated-uniwind-default-theme-variables.json";

const highlightCode: MarkdownCodeHighlighter = async ({ code }) => code.split("\n").map((line) => [{ content: line, color: null, fontStyle: null }]);
/** The original T3 selectable Markdown renderer, supplied only presentation props. */
export function ChatMarkdown({ markdown }: { markdown: string }) {
  const dark = useColorScheme() === "dark";
  const palette: Record<string, string> = dark ? variables.dark : variables.light;
  const color = palette["--color-foreground"] ?? (dark ? "#fafafa" : "#18181b");
  const muted = palette["--color-foreground-muted"] ?? "#71717a";
  const surface = palette["--color-subtle"] ?? (dark ? "#27272a" : "#f4f4f5");
  const style: NativeMarkdownTextStyle = {
    color, strongColor: color, mutedColor: muted,
    linkColor: dark ? "#93c5fd" : "#1d4ed8", inlineCodeColor: color, codeColor: color,
    codeBackgroundColor: surface, codeBlockBackgroundColor: surface,
    fileTextColor: color, skillTextColor: color, quoteMarkerColor: muted,
    dividerColor: palette["--color-border"] ?? muted,
    fontSize: 16, lineHeight: 23, fontFamily: "DMSans-Regular",
    headingFontFamily: "DMSans-Bold", boldFontFamily: "DMSans-Bold",
  };
  return <SelectableMarkdownText markdown={markdown} textStyle={style} highlightCode={highlightCode}
    onLinkPress={(href) => {
      // Workspace links remain display-only until our file interface is implemented.
      if (/^https?:\/\//i.test(href)) void Linking.openURL(href).catch(() => {});
    }} />;
}
