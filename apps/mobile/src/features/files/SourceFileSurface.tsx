import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import type { ComponentType } from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FlatList,
  type LayoutChangeEvent,
  ScrollView,
  Text as NativeText,
  useColorScheme,
  useWindowDimensions,
  View,
} from "react-native";

import { AppText as Text } from "../../components/AppText";
import { LoadingStrip } from "../../components/LoadingStrip";
import {
  type NativeReviewDiffViewProps,
  resolveNativeReviewDiffView,
} from "../diffs/nativeReviewDiffSurface";
import { createNativeReviewDiffTheme } from "../review/nativeReviewDiffAdapter";
import { REVIEW_MONO_FONT_FAMILY, renderVisibleWhitespace } from "../review/reviewDiffRendering";
import type { ReviewHighlightedToken } from "../review/shikiReviewHighlighter";
import { cn } from "../../lib/cn";
import type { ResolvedMobileCodeSurface } from "../../lib/appearancePreferences";
import { useAppearanceCodeSurface } from "../settings/appearance/useAppearanceCodeSurface";
import {
  buildNativeSourceTokens,
  buildNativeSourceRows,
  NATIVE_SOURCE_CONTENT_WIDTH,
  nativeSourceRowIdsForLine,
  nativeSourceRowIndexForLine,
  nativeSourceWrapColumns,
} from "./nativeSourceFileAdapter";
import { prepareSourceFileDocument } from "./source-file-document";
import { sourceHighlightAtom } from "./sourceHighlightingState";

interface SourceFileSurfaceProps {
  readonly contents: string;
  readonly path: string;
  readonly initialLine?: number | null;
  /** Enables native pull-to-refresh on the source surface. */
  readonly onRefresh?: () => Promise<void> | void;
}

type SourceHighlightStatus = "highlighting" | "ready" | "error";

const HighlightedSourceLine = memo(function HighlightedSourceLine(props: {
  readonly codeSurface: ResolvedMobileCodeSurface;
  readonly index: number;
  readonly line: string;
  readonly tokens: ReadonlyArray<ReviewHighlightedToken> | null;
  readonly highlighted: boolean;
  readonly wordBreak: boolean;
}) {
  return (
    <View
      className={cn("flex-row", props.highlighted && "bg-primary/10")}
      style={{ minHeight: props.codeSurface.rowHeight }}
    >
      <NativeText
        className="select-none pr-3 text-right text-foreground-tertiary"
        style={{
          width: props.codeSurface.gutterWidth,
          fontFamily: REVIEW_MONO_FONT_FAMILY,
          fontSize: props.codeSurface.lineNumberFontSize,
          lineHeight: props.codeSurface.rowHeight,
        }}
      >
        {props.index + 1}
      </NativeText>
      <NativeText
        selectable
        numberOfLines={props.wordBreak ? undefined : 1}
        className="flex-1 font-normal text-foreground"
        style={{
          fontFamily: REVIEW_MONO_FONT_FAMILY,
          fontSize: props.codeSurface.fontSize,
          lineHeight: props.codeSurface.rowHeight,
          minWidth: props.wordBreak ? undefined : 320,
        }}
      >
        {props.tokens && props.tokens.length > 0
          ? (() => {
              let offset = 0;
              return props.tokens.map((token) => {
                const start = offset;
                offset += token.content.length;

                const fontWeight =
                  token.fontStyle !== null && (token.fontStyle & 2) === 2
                    ? ("700" as const)
                    : ("400" as const);
                const fontStyle =
                  token.fontStyle !== null && (token.fontStyle & 1) === 1
                    ? ("italic" as const)
                    : ("normal" as const);

                return (
                  <NativeText
                    key={`${start}:${token.content.length}:${token.color ?? ""}`}
                    selectable
                    style={{
                      color: token.color ?? undefined,
                      fontFamily: REVIEW_MONO_FONT_FAMILY,
                      fontWeight,
                      fontStyle,
                    }}
                  >
                    {token.content.length > 0 ? renderVisibleWhitespace(token.content) : " "}
                  </NativeText>
                );
              });
            })()
          : renderVisibleWhitespace(props.line || " ")}
      </NativeText>
    </View>
  );
});

function useSourceFileModel(props: SourceFileSurfaceProps) {
  const colorScheme = useColorScheme();
  const theme: "dark" | "light" = colorScheme === "dark" ? "dark" : "light";
  const document = useMemo(() => prepareSourceFileDocument(props.contents), [props.contents]);
  const { contents: normalizedContents, lines, rowsJson } = document;
  const targetIndex =
    props.initialLine !== null && props.initialLine !== undefined && props.initialLine > 0
      ? Math.min(Math.floor(props.initialLine) - 1, Math.max(0, lines.length - 1))
      : null;
  const highlightAtom = useMemo(
    () => sourceHighlightAtom({ path: props.path, contents: normalizedContents, theme }),
    [normalizedContents, props.path, theme],
  );
  const highlightResult = useAtomValue(highlightAtom);
  const tokens = AsyncResult.isSuccess(highlightResult) ? highlightResult.value : null;
  const status: SourceHighlightStatus = AsyncResult.isFailure(highlightResult)
    ? "error"
    : AsyncResult.isSuccess(highlightResult)
      ? "ready"
      : "highlighting";

  return { lines, rowsJson, status, targetIndex, theme, tokens };
}

function SourceHighlightStatusView(props: { readonly status: SourceHighlightStatus }) {
  if (props.status === "highlighting") {
    return <LoadingStrip />;
  }
  if (props.status === "error") {
    return (
      <View className="border-b border-border bg-card px-4 py-2">
        <Text className="text-2xs font-t3-medium uppercase text-foreground-muted">Plain text</Text>
      </View>
    );
  }
  return null;
}

function NativeSourceFileSurface(
  props: SourceFileSurfaceProps & {
    readonly NativeView: ComponentType<NativeReviewDiffViewProps>;
  },
) {
  const { NativeView, onRefresh } = props;
  const { codeSurface, codeWordBreak, nativeSourceStyle } = useAppearanceCodeSurface();
  const { width: windowWidth } = useWindowDimensions();
  const [surfaceWidth, setSurfaceWidth] = useState(windowWidth);
  const {
    lines,
    rowsJson: unwrappedRowsJson,
    status,
    targetIndex,
    theme,
    tokens,
  } = useSourceFileModel(props);
  const [isPullRefreshing, setIsPullRefreshing] = useState(false);
  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const nextWidth = Math.round(event.nativeEvent.layout.width);
    if (nextWidth <= 0) {
      return;
    }
    setSurfaceWidth((currentWidth) => (currentWidth === nextWidth ? currentWidth : nextWidth));
  }, []);
  const handlePullToRefresh = useCallback(async () => {
    if (!onRefresh) {
      return;
    }
    setIsPullRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setIsPullRefreshing(false);
    }
  }, [onRefresh]);
  const wrapColumns = codeWordBreak
    ? nativeSourceWrapColumns(surfaceWidth, codeSurface)
    : undefined;
  const rowsJson = useMemo(
    () =>
      wrapColumns === undefined
        ? unwrappedRowsJson
        : JSON.stringify(buildNativeSourceRows(lines, wrapColumns)),
    [lines, unwrappedRowsJson, wrapColumns],
  );
  const tokensJson = useMemo(
    () => JSON.stringify(buildNativeSourceTokens(tokens, wrapColumns)),
    [tokens, wrapColumns],
  );
  const initialRowIndex =
    targetIndex === null ? -1 : nativeSourceRowIndexForLine(lines, targetIndex, wrapColumns);
  const selectedRowIdsJson = useMemo(
    () =>
      JSON.stringify(
        targetIndex === null
          ? []
          : nativeSourceRowIdsForLine(lines[targetIndex] ?? "", targetIndex, wrapColumns),
      ),
    [lines, targetIndex, wrapColumns],
  );
  const themeJson = useMemo(() => JSON.stringify(createNativeReviewDiffTheme(theme)), [theme]);
  const styleJson = useMemo(() => JSON.stringify(nativeSourceStyle), [nativeSourceStyle]);
  return (
    <View className="relative flex-1 bg-sheet" onLayout={handleLayout}>
      <SourceHighlightStatusView status={status} />
      <NativeView
        collapsable={false}
        testID="source-native-code-view"
        style={{ flex: 1 }}
        appearanceScheme={theme}
        contentResetKey={props.path}
        contentWidth={
          codeWordBreak
            ? Math.max(240, surfaceWidth - codeSurface.gutterWidth - 24)
            : NATIVE_SOURCE_CONTENT_WIDTH
        }
        initialRowIndex={initialRowIndex}
        rowHeight={nativeSourceStyle.rowHeight ?? codeSurface.rowHeight}
        rowsJson={rowsJson}
        selectedRowIdsJson={selectedRowIdsJson}
        styleJson={styleJson}
        themeJson={themeJson}
        tokensJson={tokensJson}
        {...(onRefresh
          ? {
              refreshing: isPullRefreshing,
              onPullToRefresh: () => void handlePullToRefresh(),
            }
          : {})}
      />
    </View>
  );
}

function JavaScriptSourceFileSurface(props: SourceFileSurfaceProps) {
  const { codeSurface, codeWordBreak } = useAppearanceCodeSurface();
  const { lines, status, targetIndex, tokens } = useSourceFileModel(props);
  const listRef = useRef<FlatList<string>>(null);

  useEffect(() => {
    if (targetIndex === null) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      listRef.current?.scrollToIndex({ index: targetIndex, animated: false, viewPosition: 0.3 });
    });
    return () => cancelAnimationFrame(frame);
  }, [props.path, targetIndex]);

  const renderLine = useCallback(
    ({ item, index }: { item: string; index: number }) => (
      <HighlightedSourceLine
        codeSurface={codeSurface}
        index={index}
        line={item}
        tokens={tokens?.[index] ?? null}
        highlighted={index === targetIndex}
        wordBreak={codeWordBreak}
      />
    ),
    [codeSurface, codeWordBreak, targetIndex, tokens],
  );

  const list = (
    <FlatList
      ref={listRef}
      data={lines}
      keyExtractor={(_line, index) => String(index)}
      initialNumToRender={80}
      maxToRenderPerBatch={80}
      windowSize={12}
      {...(codeWordBreak
        ? {}
        : {
            getItemLayout: (_data, index) => ({
              length: codeSurface.rowHeight,
              offset: codeSurface.rowHeight * index,
              index,
            }),
          })}
      contentContainerStyle={{
        minWidth: codeWordBreak ? undefined : "100%",
        paddingBottom: codeSurface.rowHeight,
        paddingTop: 8,
      }}
      renderItem={renderLine}
    />
  );

  return (
    <View className="relative flex-1 bg-sheet">
      <SourceHighlightStatusView status={status} />
      {codeWordBreak ? (
        list
      ) : (
        <ScrollView horizontal bounces={false} className="flex-1">
          {list}
        </ScrollView>
      )}
    </View>
  );
}

export function SourceFileSurface(props: SourceFileSurfaceProps) {
  const NativeView = resolveNativeReviewDiffView();
  return NativeView ? (
    <NativeSourceFileSurface {...props} NativeView={NativeView} />
  ) : (
    <JavaScriptSourceFileSurface {...props} />
  );
}
