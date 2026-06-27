import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import type { ComponentType } from "react";
import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { FlatList, ScrollView, Text as NativeText, useColorScheme, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { LoadingStrip } from "../../components/LoadingStrip";
import {
  type NativeReviewDiffViewProps,
  resolveNativeReviewDiffView,
} from "../diffs/nativeReviewDiffSurface";
import { createNativeReviewDiffTheme } from "../review/nativeReviewDiffAdapter";
import {
  REVIEW_DIFF_LINE_HEIGHT,
  REVIEW_MONO_FONT_FAMILY,
  renderVisibleWhitespace,
} from "../review/reviewDiffRendering";
import type { ReviewHighlightedToken } from "../review/shikiReviewHighlighter";
import { cn } from "../../lib/cn";
import { MOBILE_CODE_SURFACE } from "../../lib/typography";
import {
  buildNativeSourceTokens,
  NATIVE_SOURCE_CONTENT_WIDTH,
  NATIVE_SOURCE_ROW_HEIGHT,
  NATIVE_SOURCE_STYLE,
  nativeSourceRowId,
} from "./nativeSourceFileAdapter";
import { prepareSourceFileDocument } from "./source-file-document";
import { sourceHighlightAtom } from "./sourceHighlightingState";

const SOURCE_LINE_HEIGHT = MOBILE_CODE_SURFACE.rowHeight;
const SOURCE_LINE_NUMBER_WIDTH = MOBILE_CODE_SURFACE.gutterWidth;
const NATIVE_SOURCE_STYLE_JSON = JSON.stringify(NATIVE_SOURCE_STYLE);

interface SourceFileSurfaceProps {
  readonly contents: string;
  readonly path: string;
  readonly initialLine?: number | null;
}

type SourceHighlightStatus = "highlighting" | "ready" | "error";

const HighlightedSourceLine = memo(function HighlightedSourceLine(props: {
  readonly index: number;
  readonly line: string;
  readonly tokens: ReadonlyArray<ReviewHighlightedToken> | null;
  readonly highlighted: boolean;
}) {
  return (
    <View
      className={cn("flex-row", props.highlighted && "bg-primary/10")}
      style={{ minHeight: SOURCE_LINE_HEIGHT }}
    >
      <NativeText
        className="select-none pr-3 text-right text-foreground-tertiary"
        style={{
          width: SOURCE_LINE_NUMBER_WIDTH,
          fontFamily: REVIEW_MONO_FONT_FAMILY,
          fontSize: MOBILE_CODE_SURFACE.lineNumberFontSize,
          lineHeight: MOBILE_CODE_SURFACE.rowHeight,
        }}
      >
        {props.index + 1}
      </NativeText>
      <NativeText
        selectable
        numberOfLines={1}
        className="font-normal text-foreground"
        style={{
          fontFamily: REVIEW_MONO_FONT_FAMILY,
          fontSize: MOBILE_CODE_SURFACE.fontSize,
          lineHeight: MOBILE_CODE_SURFACE.rowHeight,
          minWidth: 320,
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
  const { NativeView } = props;
  const { rowsJson, status, targetIndex, theme, tokens } = useSourceFileModel(props);
  const tokensJson = useMemo(() => JSON.stringify(buildNativeSourceTokens(tokens)), [tokens]);
  const selectedRowIdsJson = useMemo(
    () => JSON.stringify(targetIndex === null ? [] : [nativeSourceRowId(targetIndex)]),
    [targetIndex],
  );
  const themeJson = useMemo(() => JSON.stringify(createNativeReviewDiffTheme(theme)), [theme]);

  return (
    <View className="relative flex-1 bg-card">
      <SourceHighlightStatusView status={status} />
      <NativeView
        collapsable={false}
        testID="source-native-code-view"
        style={{ flex: 1 }}
        appearanceScheme={theme}
        contentResetKey={props.path}
        contentWidth={NATIVE_SOURCE_CONTENT_WIDTH}
        initialRowIndex={targetIndex ?? -1}
        rowHeight={NATIVE_SOURCE_ROW_HEIGHT}
        rowsJson={rowsJson}
        selectedRowIdsJson={selectedRowIdsJson}
        styleJson={NATIVE_SOURCE_STYLE_JSON}
        themeJson={themeJson}
        tokensJson={tokensJson}
      />
    </View>
  );
}

function JavaScriptSourceFileSurface(props: SourceFileSurfaceProps) {
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
        index={index}
        line={item}
        tokens={tokens?.[index] ?? null}
        highlighted={index === targetIndex}
      />
    ),
    [targetIndex, tokens],
  );

  return (
    <View className="relative flex-1 bg-card">
      <SourceHighlightStatusView status={status} />
      <ScrollView horizontal bounces={false} className="flex-1">
        <FlatList
          ref={listRef}
          data={lines}
          keyExtractor={(_line, index) => String(index)}
          initialNumToRender={80}
          maxToRenderPerBatch={80}
          windowSize={12}
          getItemLayout={(_data, index) => ({
            length: SOURCE_LINE_HEIGHT,
            offset: SOURCE_LINE_HEIGHT * index,
            index,
          })}
          contentContainerStyle={{
            minWidth: "100%",
            paddingBottom: REVIEW_DIFF_LINE_HEIGHT,
            paddingTop: 8,
          }}
          renderItem={renderLine}
        />
      </ScrollView>
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
