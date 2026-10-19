import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import type { ComponentType } from "react";
import { useEffect, useRef, useState } from "react";
import {
  FlatList,
  Platform,
  RefreshControl,
  ScrollView,
  Text as NativeText,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText as Text } from "../../components/ui/AppText";
import { LoadingStrip } from "../../components/ui/LoadingStrip";
import { useNativeColumnLayoutMetrics } from "../../native/native-layout-metrics";
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
import { SourceText } from "@t3tools/mobile-source-text";

import { boundedSelectableSourceTokens, prepareSourceFileDocument } from "./source-file-document";
import { sourceHighlightAtom } from "./sourceHighlightingState";

interface SourceFileSurfaceProps {
  readonly contents: string;
  readonly path: string;
  readonly embedded?: boolean;
  readonly initialLine?: number | null;
  readonly headerInsetTop?: number;
  readonly selectable?: boolean;
  readonly onRefresh?: () => Promise<void> | void;
}

type SourceHighlightStatus = "highlighting" | "ready" | "error";

const HighlightedSourceLine = function HighlightedSourceLine(props: {
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
        selectionColorClassName={Platform.OS === "android" ? "accent-focus/32" : undefined}
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
                    selectionColorClassName={
                      Platform.OS === "android" ? "accent-focus/32" : undefined
                    }
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
};

function useSourceFileModel(props: SourceFileSurfaceProps) {
  const { themeAppearance: theme } = useAppearancePreferences();
  const document = prepareSourceFileDocument(props.contents);
  const { contents: normalizedContents, lines, rowsJson } = document;
  const targetIndex =
    props.initialLine !== null && props.initialLine !== undefined && props.initialLine > 0
      ? Math.min(Math.floor(props.initialLine) - 1, Math.max(0, lines.length - 1))
      : null;
  const highlightAtom = sourceHighlightAtom({
    path: props.path,
    contents: normalizedContents,
    theme,
  });
  const highlightResult = useAtomValue(highlightAtom);
  const tokens = AsyncResult.isSuccess(highlightResult) ? highlightResult.value : null;
  const status: SourceHighlightStatus = AsyncResult.isFailure(highlightResult)
    ? "error"
    : AsyncResult.isSuccess(highlightResult)
      ? "ready"
      : "highlighting";

  return { normalizedContents, lines, rowsJson, status, targetIndex, theme, tokens };
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

function useSourceFileRefresh(onRefresh: SourceFileSurfaceProps["onRefresh"]) {
  const [isPullRefreshing, setIsPullRefreshing] = useState(false);
  const handlePullToRefresh = async () => {
    if (!onRefresh) {
      return;
    }
    setIsPullRefreshing(true);
    // RefreshControl only needs the spinner cleared; the caller surfaces its own errors.
    await settlePromise(async () => onRefresh());
    setIsPullRefreshing(false);
  };
  return { isPullRefreshing, handlePullToRefresh };
}

function NativeSourceFileSurface(
  props: SourceFileSurfaceProps & {
    readonly NativeView: ComponentType<NativeReviewDiffViewProps>;
  },
) {
  const { NativeView, onRefresh } = props;
  const insets = useSafeAreaInsets();
  const columnMetrics = useNativeColumnLayoutMetrics();
  const safeArea = columnMetrics?.safeArea ?? insets;
  const { codeSurface, codeWordBreak, nativeSourceStyle } = useAppearanceCodeSurface();
  const { themeAppearance, themeId } = useAppearancePreferences();
  const appTheme = useUniwindTheme();
  const { width: viewportWidth } = useWindowDimensions();
  const { rowsJson, status, targetIndex, tokens } = useSourceFileModel(props);
  const { isPullRefreshing, handlePullToRefresh } = useSourceFileRefresh(onRefresh);
  const tokensJson = JSON.stringify(buildNativeSourceTokens(tokens));
  const selectedRowIdsJson = JSON.stringify(
    targetIndex === null ? [] : [nativeSourceRowId(targetIndex)],
  );
  const themeJson = JSON.stringify(createNativeReviewDiffTheme(themeAppearance, themeId, appTheme));
  const styleJson = JSON.stringify(nativeSourceStyle);
  const contentWidth = codeWordBreak
    ? Math.max(240, viewportWidth - codeSurface.gutterWidth - 24)
    : NATIVE_SOURCE_CONTENT_WIDTH;

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
        contentInsetTop={props.embedded ? 0 : (props.headerInsetTop ?? safeArea.top)}
        contentInsetBottom={props.embedded ? 0 : safeArea.bottom + 8}
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
  const usesAutomaticInsets = Platform.OS === "ios" && !props.embedded;
  const foreground = useUniwindTheme()["--color-foreground"];
  const { codeSurface, codeWordBreak } = useAppearanceCodeSurface();
  const { normalizedContents, lines, status, targetIndex, tokens } = useSourceFileModel(props);
  const selectableTokens = props.selectable ? boundedSelectableSourceTokens(tokens) : null;
  const listRef = useRef<FlatList<string>>(null);
  const { isPullRefreshing, handlePullToRefresh } = useSourceFileRefresh(props.onRefresh);
  const refreshControl = props.onRefresh ? (
    <RefreshControl refreshing={isPullRefreshing} onRefresh={() => void handlePullToRefresh()} />
  ) : undefined;

  useEffect(() => {
    if (targetIndex === null) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      listRef.current?.scrollToIndex({ index: targetIndex, animated: false, viewPosition: 0.3 });
    });
    return () => cancelAnimationFrame(frame);
  }, [props.path, targetIndex]);

  const renderLine = ({ item, index }: { item: string; index: number }) => (
    <HighlightedSourceLine
      codeSurface={codeSurface}
      index={index}
      line={item}
      tokens={tokens?.[index] ?? null}
      highlighted={index === targetIndex}
      wordBreak={codeWordBreak}
    />
  );

  // On iOS `uiTextView` renders a real `UITextView`, which selects across every line,
  // wraps, and lays out long documents through TextKit; on Android the primitive is an RN
  // `Text`, which selects across its nested children. Either way "select all" takes the
  // file rather than a line, which a `FlatList` row can never do because each row is its
  // own selection scope.
  const selectableBlock = props.selectable ? (
    <SourceText
      selectable
      selectionColorClassName={Platform.OS === "android" ? "accent-focus/32" : undefined}
      style={{
        color: foreground,
        fontFamily: REVIEW_MONO_FONT_FAMILY,
        fontSize: codeSurface.fontSize,
        lineHeight: codeSurface.rowHeight,
      }}
    >
      {selectableTokens
        ? lines.map((line, index) => {
            const lineTokens = selectableTokens[index] ?? null;
            const body =
              lineTokens && lineTokens.length > 0
                ? lineTokens.map((token, tokenIndex) => (
                    <SourceText
                      key={`${index}:${tokenIndex}`}
                      style={{
                        color: token.color ?? foreground,
                        fontWeight:
                          token.fontStyle !== null && (token.fontStyle & 2) === 2 ? "700" : "400",
                        fontStyle:
                          token.fontStyle !== null && (token.fontStyle & 1) === 1
                            ? "italic"
                            : "normal",
                      }}
                    >
                      {token.content}
                    </SourceText>
                  ))
                : line;
            return (
              <SourceText key={index}>
                {body}
                {index < lines.length - 1 ? "\n" : ""}
              </SourceText>
            );
          })
        : normalizedContents}
    </SourceText>
  ) : null;

  const list = (
    <FlatList
      ref={listRef}
      contentInsetAdjustmentBehavior={usesAutomaticInsets ? "automatic" : "never"}
      automaticallyAdjustsScrollIndicatorInsets={usesAutomaticInsets}
      refreshControl={refreshControl}
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

  const usesLineList = !props.selectable;
  const padded = (
    <ScrollView
      refreshControl={refreshControl}
      className="flex-1"
      contentInsetAdjustmentBehavior={usesAutomaticInsets ? "automatic" : "never"}
      automaticallyAdjustsScrollIndicatorInsets={usesAutomaticInsets}
      contentContainerStyle={{
        paddingBottom: codeSurface.rowHeight,
        paddingHorizontal: 12,
        paddingTop: 8,
      }}
    >
      {selectableBlock}
    </ScrollView>
  );

  return (
    <View className="relative flex-1 bg-sheet">
      <SourceHighlightStatusView status={status} />
      {usesLineList ? (
        codeWordBreak ? (
          list
        ) : (
          <ScrollView horizontal bounces={false} className="flex-1">
            {list}
          </ScrollView>
        )
      ) : codeWordBreak ? (
        padded
      ) : (
        <ScrollView horizontal bounces={false} className="flex-1">
          {padded}
        </ScrollView>
      )}
    </View>
  );
}

export function SourceFileSurface(props: SourceFileSurfaceProps) {
  const NativeView = resolveNativeReviewDiffView();
  const { codeWordBreak } = useAppearanceCodeSurface();
  const surface =
    NativeView && !codeWordBreak && !props.selectable ? (
      <NativeSourceFileSurface {...props} NativeView={NativeView} />
    ) : (
      <JavaScriptSourceFileSurface {...props} />
    );
  return surface;
}
