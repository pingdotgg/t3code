import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import type { ComponentType } from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, ScrollView, Text as NativeText, View } from "react-native";

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
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import {
  buildNativeSourceTokens,
  NATIVE_SOURCE_CONTENT_WIDTH,
  nativeSourceRowId,
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
        allowFontScaling={false}
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
        allowFontScaling={false}
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
  const { themeAppearance: theme } = useAppearancePreferences();
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
  const { codeSurface, nativeSourceStyle } = useAppearanceCodeSurface();
  const { themeAppearance, themeId } = useAppearancePreferences();
  const appTheme = useUniwindTheme();
  const { rowsJson, status, targetIndex, tokens } = useSourceFileModel(props);
  const [isPullRefreshing, setIsPullRefreshing] = useState(false);
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
  const tokensJson = useMemo(() => JSON.stringify(buildNativeSourceTokens(tokens)), [tokens]);
  const selectedRowIdsJson = useMemo(
    () => JSON.stringify(targetIndex === null ? [] : [nativeSourceRowId(targetIndex)]),
    [targetIndex],
  );
  const themeJson = useMemo(
    () => JSON.stringify(createNativeReviewDiffTheme(themeAppearance, themeId, appTheme)),
    [appTheme, themeAppearance, themeId],
  );
  const styleJson = useMemo(() => JSON.stringify(nativeSourceStyle), [nativeSourceStyle]);
  const contentWidth = NATIVE_SOURCE_CONTENT_WIDTH;

  return (
    <View className="relative flex-1 bg-sheet">
      <SourceHighlightStatusView status={status} />
      <NativeView
        collapsable={false}
        testID="source-native-code-view"
        style={{ flex: 1 }}
        appearanceScheme={themeAppearance}
        contentResetKey={props.path}
        contentWidth={contentWidth}
        initialRowIndex={targetIndex ?? -1}
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
  const [isPullRefreshing, setIsPullRefreshing] = useState(false);

  const handlePullToRefresh = useCallback(async () => {
    if (!props.onRefresh) {
      return;
    }
    setIsPullRefreshing(true);
    try {
      await props.onRefresh();
    } finally {
      setIsPullRefreshing(false);
    }
  }, [props.onRefresh]);
  const scrollRetryCountRef = useRef(0);
  const retryFrameRef = useRef<number | null>(null);
  const targetIndexRef = useRef<number | null>(null);
  targetIndexRef.current = targetIndex;

  useEffect(() => {
    if (targetIndex === null) {
      return;
    }
    scrollRetryCountRef.current = 0;
    const frame = requestAnimationFrame(() => {
      listRef.current?.scrollToIndex({ index: targetIndex, animated: false, viewPosition: 0.3 });
    });
    return () => {
      cancelAnimationFrame(frame);
      if (retryFrameRef.current !== null) {
        cancelAnimationFrame(retryFrameRef.current);
        retryFrameRef.current = null;
      }
    };
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

  const handleScrollToIndexFailed = useCallback(
    (info: { index: number; averageItemLength: number }) => {
      listRef.current?.scrollToOffset({
        offset: Math.max(0, info.averageItemLength * info.index),
        animated: false,
      });
      if (retryFrameRef.current !== null || scrollRetryCountRef.current >= 3) {
        return;
      }
      scrollRetryCountRef.current += 1;
      retryFrameRef.current = requestAnimationFrame(() => {
        retryFrameRef.current = null;
        if (targetIndexRef.current === null || targetIndexRef.current !== info.index) {
          return;
        }
        listRef.current?.scrollToIndex({
          index: info.index,
          animated: false,
          viewPosition: 0.3,
        });
      });
    },
    [],
  );

  const list = (
    <FlatList
      ref={listRef}
      data={lines}
      keyExtractor={(_line, index) => String(index)}
      initialNumToRender={80}
      maxToRenderPerBatch={80}
      windowSize={12}
      onScrollToIndexFailed={handleScrollToIndexFailed}
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
      {...(props.onRefresh
        ? {
            refreshing: isPullRefreshing,
            onRefresh: () => void handlePullToRefresh(),
          }
        : {})}
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
  const { codeWordBreak } = useAppearanceCodeSurface();
  if (codeWordBreak) {
    return <JavaScriptSourceFileSurface {...props} />;
  }
  const NativeView = resolveNativeReviewDiffView();
  return NativeView ? (
    <NativeSourceFileSurface {...props} NativeView={NativeView} />
  ) : (
    <JavaScriptSourceFileSurface {...props} />
  );
}
