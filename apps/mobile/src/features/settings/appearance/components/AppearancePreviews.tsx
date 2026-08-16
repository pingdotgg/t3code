import { Platform, ScrollView, type StyleProp, type TextStyle, View } from "react-native";

import { AppText as Text } from "../../../../components/AppText";
import {
  resolveMarkdownFontSizes,
  resolveMobileCodeSurface,
} from "../../../../lib/appearancePreferences";
import { useThemeColor } from "../../../../lib/useThemeColor";
import { getMobileTerminalTheme } from "../../../terminal/terminalTheme";
import { useAppearancePreferences } from "../AppearancePreferencesProvider";

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
  const { themeAppearance: scheme, themeId } = useAppearancePreferences();
  const theme = getMobileTerminalTheme(themeId, scheme);
  const lineHeight = Math.round(props.fontSize * 1.6);
  const lineStyle = {
    fontFamily: "Menlo",
    fontSize: props.fontSize,
    lineHeight,
  } as const;
  // AppText stamps the sans font on every node, so nested spans must
  // re-apply the terminal font instead of relying on inheritance, exactly
  // like the code preview's tokens below.
  const span = (color: string, extra?: TextStyle): StyleProp<TextStyle> => [
    lineStyle,
    { color, ...extra },
  ];

  return (
    <View className="p-4">
      <Text style={span(theme.foreground)}>
        <Text style={span(theme.palette[2])}>→ </Text>
        <Text style={span(theme.palette[6])}>t3code </Text>
        <Text style={span(theme.palette[4])}>git:(</Text>
        <Text style={span(theme.palette[1])}>main</Text>
        <Text style={span(theme.palette[4])}>)</Text>
        <Text style={span(theme.palette[3])}> ✗</Text>
        <Text style={span(theme.foreground)}> vpr dev</Text>
      </Text>
      <Text style={span(theme.foreground)}>
        <Text style={span(theme.palette[2])}>VITE v7.1.1</Text>
        <Text style={span(theme.mutedForeground)}> ready in</Text>
        <Text style={span(theme.foreground)}> 1.24s</Text>
      </Text>
      <Text style={span(theme.foreground)}>
        <Text style={span(theme.palette[2])}>→ </Text>
        <Text style={span(theme.mutedForeground)}>Local: </Text>
        <Text style={span(theme.palette[6], { textDecorationLine: "underline" })}>
          http://127.0.0.1:5173/
        </Text>
      </Text>
      <Text style={span(theme.foreground)}>
        <Text style={span(theme.palette[2])}>✓ 85 passed</Text>
        <Text style={span(theme.palette[3])}> △ 2 warnings</Text>
        <Text style={span(theme.palette[1])}> ✗ 0 failed</Text>
      </Text>
      <Text style={span(theme.foreground)}>
        <Text style={span(theme.background, { backgroundColor: theme.palette[2] })}>
          {" READY "}
        </Text>
        <Text style={span(theme.mutedForeground)}> watching for changes</Text>{" "}
        <Text style={span(theme.cursorForeground)}>▏</Text>
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
