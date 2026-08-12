import { useCallback, useMemo } from "react";
import {
  Markdown,
  type CustomRenderers,
  type NodeStyleOverrides,
  type PartialMarkdownTheme,
} from "react-native-nitro-markdown";
import { Text as NativeText, View } from "react-native";

import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { useFontFamily } from "../../lib/useFontFamily";
import {
  resolveMarkdownFontSizes,
  resolveNativeMarkdownTypography,
} from "../../lib/appearancePreferences";
import { useThemeColor } from "../../lib/useThemeColor";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import {
  hasNativeSelectableMarkdownText,
  SelectableMarkdownText,
} from "../../native/SelectableMarkdownText";

export function PullRequestMarkdown(props: { readonly markdown: string }) {
  const { appearance } = useAppearancePreferences();
  const markdownFontSizes = useMemo(
    () => resolveMarkdownFontSizes(appearance.baseFontSize),
    [appearance.baseFontSize],
  );
  const nativeMarkdownTypography = useMemo(
    () => resolveNativeMarkdownTypography(appearance.baseFontSize),
    [appearance.baseFontSize],
  );
  const body = String(useThemeColor("--color-md-body"));
  const strong = String(useThemeColor("--color-md-strong"));
  const link = String(useThemeColor("--color-md-link"));
  const blockquoteBorder = String(useThemeColor("--color-md-blockquote-border"));
  const blockquoteBackground = String(useThemeColor("--color-md-blockquote-bg"));
  const codeBackground = String(useThemeColor("--color-md-code-bg"));
  const codeText = String(useThemeColor("--color-md-code-text"));
  const horizontalRule = String(useThemeColor("--color-md-hr"));
  const regularFontFamily = useFontFamily("regular");
  const mediumFontFamily = useFontFamily("medium");
  const boldFontFamily = useFontFamily("bold");
  const onLinkPress = useCallback((href: string) => {
    void tryOpenExternalUrl(href, "markdown-link");
  }, []);

  const renderers: CustomRenderers = useMemo(
    () => ({
      link: ({ href, children }) => (
        <NativeText
          className="font-t3-medium"
          onPress={() => {
            if (href) onLinkPress(href);
          }}
          style={{ color: link, textDecorationLine: "none" }}
        >
          {children}
        </NativeText>
      ),
    }),
    [link, onLinkPress],
  );
  const theme: PartialMarkdownTheme = useMemo(
    () => ({
      colors: {
        text: body,
        heading: strong,
        link,
        blockquote: blockquoteBorder,
        border: horizontalRule,
        surface: "transparent",
        surfaceLight: blockquoteBackground,
        accent: link,
        tableBorder: horizontalRule,
        tableHeader: blockquoteBackground,
        tableHeaderText: strong,
        tableRowOdd: blockquoteBackground,
        tableRowEven: "transparent",
        code: codeText,
        codeBackground,
      },
    }),
    [
      blockquoteBackground,
      blockquoteBorder,
      body,
      codeBackground,
      codeText,
      horizontalRule,
      link,
      strong,
    ],
  );
  const styles: NodeStyleOverrides = useMemo(
    () => ({
      text: {
        color: body,
        fontFamily: regularFontFamily,
        fontSize: markdownFontSizes.m,
        lineHeight: markdownFontSizes.bodyLineHeight,
      },
      heading: { color: strong, fontFamily: boldFontFamily },
      strong: { color: strong, fontFamily: boldFontFamily },
      link: { color: link, fontFamily: mediumFontFamily },
      blockquote: {
        backgroundColor: blockquoteBackground,
        borderLeftColor: blockquoteBorder,
        borderLeftWidth: 3,
        paddingLeft: 12,
      },
      code: { backgroundColor: codeBackground, color: codeText, fontFamily: regularFontFamily },
    }),
    [
      blockquoteBackground,
      blockquoteBorder,
      body,
      boldFontFamily,
      codeBackground,
      codeText,
      link,
      markdownFontSizes.bodyLineHeight,
      markdownFontSizes.m,
      mediumFontFamily,
      regularFontFamily,
      strong,
    ],
  );

  if (props.markdown.trim().length === 0) {
    return null;
  }

  return (
    <View>
      {hasNativeSelectableMarkdownText() ? (
        <SelectableMarkdownText
          markdown={props.markdown}
          onLinkPress={onLinkPress}
          textStyle={{
            color: body,
            strongColor: strong,
            mutedColor: body,
            linkColor: link,
            inlineCodeColor: codeText,
            codeColor: codeText,
            codeBackgroundColor: codeBackground,
            codeBlockBackgroundColor: codeBackground,
            fileTextColor: codeText,
            skillTextColor: codeText,
            quoteMarkerColor: blockquoteBorder,
            dividerColor: horizontalRule,
            fontSize: nativeMarkdownTypography.fontSize,
            lineHeight: nativeMarkdownTypography.lineHeight,
            headingFontSizes: nativeMarkdownTypography.headingFontSizes,
            fontFamily: regularFontFamily,
            headingFontFamily: boldFontFamily,
            boldFontFamily,
          }}
        />
      ) : (
        <Markdown options={{ gfm: true }} renderers={renderers} styles={styles} theme={theme}>
          {props.markdown}
        </Markdown>
      )}
    </View>
  );
}
