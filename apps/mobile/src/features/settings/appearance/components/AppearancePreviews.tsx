import { Platform, ScrollView, View, useColorScheme } from "react-native";

import { AppText as Text } from "../../../../components/AppText";
import {
  resolveMarkdownFontSizes,
  resolveMobileCodeSurface,
} from "../../../../lib/appearancePreferences";
import { useThemeColor } from "../../../../lib/useThemeColor";
import { getPierreTerminalTheme } from "../../../terminal/terminalTheme";

const CODE_FONT_FAMILY = Platform.select({
  ios: "ui-monospace",
  android: "monospace",
  default: "monospace",
});

/** Hairline between a section's preview surface and its control rows. */
export function AppearancePreviewSeparator() {
  return <View className="h-px bg-separator" />;
}

/** Live sample of body text rendered at the chosen base font size. */
export function TextAppearancePreview(props: { readonly fontSize: number }) {
  const sizes = resolveMarkdownFontSizes(props.fontSize);

  return (
    <View className="gap-1 p-4">
      <Text
        className="text-foreground"
        style={{ fontSize: sizes.m, lineHeight: sizes.bodyLineHeight }}
      >
        The quick brown fox jumps over the lazy dog.
      </Text>
      <Text
        className="text-foreground-muted"
        style={{ fontSize: sizes.s, lineHeight: Math.round(sizes.s * 1.4) }}
      >
        Messages, labels, and headings scale with this size.
      </Text>
    </View>
  );
}

/**
 * Live terminal sample using the real terminal theme's text colors and font,
 * on the shared card background so it reads like the other previews.
 */
export function TerminalAppearancePreview(props: { readonly fontSize: number }) {
  const scheme = useColorScheme() === "light" ? "light" : "dark";
  const theme = getPierreTerminalTheme(scheme);
  const lineHeight = Math.round(props.fontSize * 1.6);
  const lineStyle = {
    fontFamily: "Menlo",
    fontSize: props.fontSize,
    lineHeight,
  } as const;

  return (
    <View className="p-4">
      <Text style={[lineStyle, { color: theme.foreground }]}>$ npm run dev</Text>
      <Text style={[lineStyle, { color: theme.palette[2] }]}>✓ Ready in 430ms</Text>
      <Text style={[lineStyle, { color: theme.foreground }]}>
        Local: http://localhost:3000{" "}
        <Text style={[lineStyle, { color: theme.cursorForeground }]}>▏</Text>
      </Text>
    </View>
  );
}

interface CodePreviewToken {
  readonly text: string;
  readonly keyword?: boolean;
}

interface CodePreviewLine {
  readonly id: string;
  readonly tokens: ReadonlyArray<CodePreviewToken>;
}

const CODE_PREVIEW_LINES: ReadonlyArray<CodePreviewLine> = [
  {
    id: "signature",
    tokens: [{ text: "function", keyword: true }, { text: " formatUser(user) {" }],
  },
  {
    id: "body",
    tokens: [
      { text: "  " },
      { text: "return", keyword: true },
      { text: " `${user.name} <${user.email}>` // demonstrates how long lines behave" },
    ],
  },
  { id: "close", tokens: [{ text: "}" }] },
];

/**
 * Live code sample matching the code & diff surface metrics. Long lines wrap
 * when word break is on and scroll horizontally when it is off, mirroring the
 * real code surface.
 */
export function CodeAppearancePreview(props: {
  readonly fontSize: number;
  readonly wordBreak: boolean;
}) {
  const surface = resolveMobileCodeSurface(props.fontSize);
  const lineNumberColor = useThemeColor("--color-icon-subtle");
  const keywordColor = useThemeColor("--color-md-link");

  const lineNumber = (line: CodePreviewLine, index: number) => (
    <Text
      className="text-right"
      key={line.id}
      style={{
        color: lineNumberColor,
        fontFamily: CODE_FONT_FAMILY,
        fontSize: surface.lineNumberFontSize,
        lineHeight: surface.rowHeight,
        width: 22,
      }}
    >
      {index + 1}
    </Text>
  );

  const codeLine = (line: CodePreviewLine, wrap: boolean) => (
    <Text
      className="text-foreground"
      key={line.id}
      numberOfLines={wrap ? undefined : 1}
      style={{
        fontFamily: CODE_FONT_FAMILY,
        fontSize: surface.fontSize,
        lineHeight: surface.rowHeight,
      }}
    >
      {line.tokens.map((token) => (
        <Text
          key={token.text}
          style={{
            color: token.keyword ? keywordColor : undefined,
            fontFamily: CODE_FONT_FAMILY,
            fontSize: surface.fontSize,
            lineHeight: surface.rowHeight,
          }}
        >
          {token.text}
        </Text>
      ))}
    </Text>
  );

  if (props.wordBreak) {
    return (
      <View className="p-4">
        {CODE_PREVIEW_LINES.map((line, index) => (
          <View className="flex-row" key={line.id}>
            {lineNumber(line, index)}
            <View className="flex-1 pl-3">{codeLine(line, true)}</View>
          </View>
        ))}
      </View>
    );
  }

  return (
    <View className="flex-row p-4">
      <View>{CODE_PREVIEW_LINES.map((line, index) => lineNumber(line, index))}</View>
      <ScrollView
        horizontal
        contentContainerStyle={{ paddingLeft: 12 }}
        showsHorizontalScrollIndicator={false}
      >
        <View>{CODE_PREVIEW_LINES.map((line) => codeLine(line, false))}</View>
      </ScrollView>
    </View>
  );
}
