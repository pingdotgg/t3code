import { memo, useMemo, useState } from "react";
import { getFiletypeFromFileName } from "@pierre/diffs/utils/getFiletypeFromFileName";
import { ScrollView, StyleSheet, Text as NativeText, View, type ColorValue } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { useAppearanceCodeSurface } from "../settings/appearance/useAppearanceCodeSurface";
import { resolveNativeReviewDiffView } from "../diffs/nativeReviewDiffSurface";
import {
  buildNativeReviewDiffData,
  buildNativeReviewSnippetRows,
  createNativeReviewDiffTheme,
  NATIVE_REVIEW_DIFF_CONTENT_WIDTH,
} from "./nativeReviewDiffAdapter";
import { buildReviewParsedDiff } from "./reviewModel";
import { REVIEW_MONO_FONT_FAMILY } from "./reviewDiffRendering";
import type { ReviewInlineComment } from "./reviewCommentSelection";
import { useMarkdownCodeHighlight } from "../threads/markdownCodeHighlightState";

export interface ReviewCommentColors {
  readonly background: ColorValue;
  readonly border: ColorValue;
  readonly mutedBackground: ColorValue;
  readonly text: ColorValue;
  readonly mutedText: ColorValue;
  readonly codeBackground: ColorValue;
}

export function useReviewCommentColors(): ReviewCommentColors {
  const theme = useUniwindTheme();

  return useMemo(
    () => ({
      background: theme["--color-card"],
      border: theme["--color-border"],
      mutedBackground: theme["--color-subtle"],
      text: theme["--color-foreground"],
      mutedText: theme["--color-foreground-muted"],
      codeBackground: theme["--color-md-code-bg"],
    }),
    [theme],
  );
}

export const ReviewCommentCard = memo(function ReviewCommentCard(props: {
  readonly comment: ReviewInlineComment;
  readonly colors: ReviewCommentColors;
}) {
  const { codeSurface, nativeReviewDiffStyle } = useAppearanceCodeSurface();
  const { themeAppearance: appearanceScheme, themeId } = useAppearancePreferences();
  const appTheme = useUniwindTheme();
  const [NativeReviewDiffView] = useState(() => resolveNativeReviewDiffView());
  const patch = useMemo(() => buildReviewCommentPatch(props.comment), [props.comment]);
  const parsedDiff = useMemo(
    () => buildReviewParsedDiff(patch, `thread-review-comment:${props.comment.id}`),
    [patch, props.comment.id],
  );
  const nativeReviewDiffData = useMemo(() => buildNativeReviewDiffData(parsedDiff), [parsedDiff]);
  const compactNativeRows = useMemo(() => {
    const rows = nativeReviewDiffData.rows.filter((row) => row.kind !== "file");
    return rows.length > 0 ? rows : buildNativeReviewSnippetRows(props.comment);
  }, [nativeReviewDiffData.rows, props.comment]);
  const language =
    props.comment.fenceLanguage && props.comment.fenceLanguage !== "diff"
      ? props.comment.fenceLanguage
      : getFiletypeFromFileName(props.comment.filePath);
  const addedRows = useMemo(
    () => compactNativeRows.filter((row) => row.kind === "line" && row.change !== "delete"),
    [compactNativeRows],
  );
  const deletedRows = useMemo(
    () => compactNativeRows.filter((row) => row.kind === "line" && row.change === "delete"),
    [compactNativeRows],
  );
  const addedTokens = useMarkdownCodeHighlight({
    code: addedRows.map((row) => row.content ?? "").join("\n"),
    language,
    enabled: addedRows.length > 0,
    theme: appearanceScheme,
  });
  const deletedTokens = useMarkdownCodeHighlight({
    code: deletedRows.map((row) => row.content ?? "").join("\n"),
    language,
    enabled: deletedRows.length > 0,
    theme: appearanceScheme,
  });
  const snippetTokens = useMarkdownCodeHighlight({
    code: props.comment.diff.trim(),
    language: props.comment.fenceLanguage ?? language,
    enabled: compactNativeRows.length === 0,
    theme: appearanceScheme,
  });
  const nativeTokensJson = useMemo(
    () =>
      JSON.stringify(
        Object.fromEntries([
          ...addedRows.map((row, index) => [row.id, addedTokens?.[index] ?? []]),
          ...deletedRows.map((row, index) => [row.id, deletedTokens?.[index] ?? []]),
        ]),
      ),
    [addedRows, deletedRows, addedTokens, deletedTokens],
  );
  const nativeReviewDiffTheme = useMemo(
    () => createNativeReviewDiffTheme(appearanceScheme, themeId, appTheme),
    [appearanceScheme, appTheme, themeId],
  );
  const nativeRowsJson = useMemo(() => JSON.stringify(compactNativeRows), [compactNativeRows]);
  const nativeThemeJson = useMemo(
    () => JSON.stringify(nativeReviewDiffTheme),
    [nativeReviewDiffTheme],
  );
  const nativeStyleJson = useMemo(
    () => JSON.stringify(nativeReviewDiffStyle),
    [nativeReviewDiffStyle],
  );
  const nativeDiffHeight = useMemo(
    () =>
      Math.min(
        360,
        Math.max(
          48,
          compactNativeRows.length * nativeReviewDiffStyle.rowHeight +
            nativeReviewDiffStyle.fileHeaderVerticalMargin,
        ),
      ),
    [compactNativeRows.length, nativeReviewDiffStyle],
  );
  const shouldRenderNativeDiff = NativeReviewDiffView != null && compactNativeRows.length > 0;

  return (
    <View
      className="w-full overflow-hidden rounded-[16px] border border-continuous"
      style={{
        backgroundColor: props.colors.background,
        borderColor: props.colors.border,
      }}
    >
      <View
        className="flex-row items-center gap-2 border-b px-3 py-2"
        style={{ borderColor: props.colors.border }}
      >
        <View
          className="size-6 items-center justify-center rounded-[7px] border-continuous"
          style={{ backgroundColor: props.colors.mutedBackground }}
        >
          <SymbolView
            name="doc.text"
            size={13}
            tintColor={props.colors.mutedText}
            type="monochrome"
          />
        </View>
        <View className="min-w-0 flex-1">
          <Text
            className="font-mono text-xs"
            numberOfLines={1}
            style={{ color: props.colors.text }}
          >
            {props.comment.filePath}
          </Text>
          <Text className="text-xs" style={{ color: props.colors.mutedText }}>
            {props.comment.sectionTitle} · {props.comment.rangeLabel}
          </Text>
        </View>
      </View>
      {props.comment.text.length > 0 ? (
        <View className="px-3 py-3">
          <Text selectable className="text-base leading-snug" style={{ color: props.colors.text }}>
            {props.comment.text}
          </Text>
        </View>
      ) : null}
      {shouldRenderNativeDiff ? (
        <View
          className="border-t"
          collapsable={false}
          style={{
            backgroundColor: nativeReviewDiffTheme.background,
            borderColor: props.colors.border,
            height: nativeDiffHeight,
          }}
        >
          <NativeReviewDiffView
            collapsable={false}
            style={StyleSheet.absoluteFill}
            appearanceScheme={appearanceScheme}
            contentWidth={NATIVE_REVIEW_DIFF_CONTENT_WIDTH}
            rowHeight={nativeReviewDiffStyle.rowHeight}
            rowsJson={nativeRowsJson}
            tokensJson={nativeTokensJson}
            styleJson={nativeStyleJson}
            themeJson={nativeThemeJson}
          />
        </View>
      ) : props.comment.diff.trim().length > 0 ? (
        <ScrollView
          horizontal
          nestedScrollEnabled
          directionalLockEnabled
          showsHorizontalScrollIndicator={false}
          bounces={false}
          className="border-t"
          style={{ backgroundColor: props.colors.codeBackground, borderColor: props.colors.border }}
          contentContainerStyle={{ padding: 10 }}
        >
          <NativeText
            selectable
            className="font-mono"
            style={{
              color: props.colors.text,
              fontFamily: REVIEW_MONO_FONT_FAMILY,
              fontSize: codeSurface.fontSize,
              lineHeight: codeSurface.rowHeight,
            }}
          >
            {snippetTokens
              ? snippetTokens.map((line, lineIndex) => (
                  <NativeText key={lineIndex}>
                    {lineIndex > 0 ? "\n" : ""}
                    {line.map((token, tokenIndex) => (
                      <NativeText
                        key={tokenIndex}
                        style={{
                          color: token.color ?? props.colors.text,
                          fontStyle: (token.fontStyle ?? 0) & 1 ? "italic" : "normal",
                          fontWeight: (token.fontStyle ?? 0) & 2 ? "700" : "400",
                        }}
                      >
                        {token.content}
                      </NativeText>
                    ))}
                  </NativeText>
                ))
              : props.comment.diff.trim()}
          </NativeText>
        </ScrollView>
      ) : null}
    </View>
  );
});

function buildReviewCommentPatch(comment: ReviewInlineComment): string {
  if ((comment.fenceLanguage ?? "diff") !== "diff") {
    return "";
  }
  const diff = comment.diff.trim();
  if (!diff) {
    return "";
  }

  if (diff.startsWith("diff --git ")) {
    return diff;
  }

  const normalizedPath = comment.filePath.replaceAll("\\", "/");
  return [
    `diff --git a/${normalizedPath} b/${normalizedPath}`,
    `--- a/${normalizedPath}`,
    `+++ b/${normalizedPath}`,
    diff,
  ].join("\n");
}
