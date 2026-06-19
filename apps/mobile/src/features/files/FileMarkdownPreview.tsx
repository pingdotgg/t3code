import { useMemo } from "react";
import {
  Markdown,
  type CustomRenderers,
  type NodeStyleOverrides,
  type PartialMarkdownTheme,
} from "react-native-nitro-markdown";
import { Linking, ScrollView, Text as NativeText, View } from "react-native";

import { useThemeColor } from "../../lib/useThemeColor";
import {
  hasNativeSelectableMarkdownText,
  SelectableMarkdownText,
  type NativeMarkdownTextStyle,
} from "../../native/SelectableMarkdownText";

interface MarkdownPreviewStyles {
  readonly theme: PartialMarkdownTheme;
  readonly styles: NodeStyleOverrides;
  readonly renderers: CustomRenderers;
  readonly nativeTextStyle: NativeMarkdownTextStyle;
}

function useMarkdownPreviewStyles(): MarkdownPreviewStyles {
  const body = String(useThemeColor("--color-md-body"));
  const strong = String(useThemeColor("--color-md-strong"));
  const link = String(useThemeColor("--color-md-link"));
  const blockquoteBorder = String(useThemeColor("--color-md-blockquote-border"));
  const blockquoteBackground = String(useThemeColor("--color-md-blockquote-bg"));
  const codeBackground = String(useThemeColor("--color-md-code-bg"));
  const codeText = String(useThemeColor("--color-md-code-text"));
  const horizontalRule = String(useThemeColor("--color-md-hr"));

  return useMemo(() => {
    const renderers: CustomRenderers = {
      link: ({ href, children }) => (
        <NativeText
          onPress={() => {
            if (href) {
              void Linking.openURL(href);
            }
          }}
          style={{
            color: link,
            fontFamily: "DMSans_500Medium",
            textDecorationLine: "none",
          }}
        >
          {children}
        </NativeText>
      ),
    };

    return {
      theme: {
        colors: {
          text: body,
          heading: strong,
          link,
          blockquote: blockquoteBorder,
          border: horizontalRule,
          surfaceLight: blockquoteBackground,
          accent: link,
          tableBorder: horizontalRule,
          tableHeader: blockquoteBackground,
          tableHeaderText: strong,
          code: codeText,
          codeBackground,
        },
      },
      styles: {
        text: {
          color: body,
          fontFamily: "DMSans_400Regular",
          fontSize: 15,
          lineHeight: 22,
        },
        heading: {
          color: strong,
          fontFamily: "DMSans_700Bold",
        },
        strong: {
          color: strong,
          fontFamily: "DMSans_700Bold",
        },
        link: {
          color: link,
          fontFamily: "DMSans_500Medium",
        },
        blockquote: {
          backgroundColor: blockquoteBackground,
          borderLeftColor: blockquoteBorder,
          borderLeftWidth: 3,
          paddingLeft: 12,
        },
        code: {
          backgroundColor: codeBackground,
          color: codeText,
          fontFamily: "ui-monospace",
        },
        codeBlock: {
          backgroundColor: codeBackground,
          borderRadius: 12,
          color: codeText,
          fontFamily: "ui-monospace",
          padding: 12,
        },
        hr: {
          backgroundColor: horizontalRule,
        },
      },
      renderers,
      nativeTextStyle: {
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
        fontSize: 15,
        lineHeight: 22,
        fontFamily: "DMSans_400Regular",
        headingFontFamily: "DMSans_700Bold",
        boldFontFamily: "DMSans_700Bold",
      },
    };
  }, [
    blockquoteBackground,
    blockquoteBorder,
    body,
    codeBackground,
    codeText,
    horizontalRule,
    link,
    strong,
  ]);
}

export function FileMarkdownPreview(props: { readonly markdown: string }) {
  const styles = useMarkdownPreviewStyles();

  return (
    <ScrollView className="flex-1 bg-card" contentContainerStyle={{ padding: 18 }}>
      <View className="mx-auto w-full max-w-[760px]">
        {hasNativeSelectableMarkdownText() ? (
          <SelectableMarkdownText markdown={props.markdown} textStyle={styles.nativeTextStyle} />
        ) : (
          <Markdown
            options={{ gfm: true }}
            renderers={styles.renderers}
            styles={styles.styles}
            theme={styles.theme}
          >
            {props.markdown}
          </Markdown>
        )}
      </View>
    </ScrollView>
  );
}
