import type { VcsPanelFileChange, VcsPanelFileDiffInput } from "@t3tools/contracts";
import { EnvironmentId } from "@t3tools/contracts";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useEffect, useMemo, useState } from "react";
import {
  Platform,
  ScrollView,
  StyleSheet,
  Text as NativeText,
  useColorScheme,
  View,
} from "react-native";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import { resolveNativeReviewDiffView } from "../diffs/nativeReviewDiffSurface";
import { useAppearanceCodeSurface } from "../settings/appearance/useAppearanceCodeSurface";
import {
  getCachedNativeReviewDiffData,
  NATIVE_REVIEW_DIFF_CONTENT_WIDTH,
  type BuildNativeReviewDiffDataInput,
} from "../review/nativeReviewDiffAdapter";
import { buildReviewParsedDiff } from "../review/reviewModel";
import { useNativeReviewDiffBridge } from "../review/useNativeReviewDiffBridge";
import {
  VersionControlCommandInterrupted,
  useVersionControlPanelApi,
} from "./useVersionControlPanelApi";

const EMPTY_IDS: readonly string[] = [];
const EMPTY_COMMENTS: NonNullable<BuildNativeReviewDiffDataInput["comments"]> = [];

type VersionControlDiffRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly cwd: string;
  readonly file: VcsPanelFileChange;
  readonly source: NonNullable<VcsPanelFileDiffInput["source"]>;
}>;

type DiffState =
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly patch: string }
  | { readonly status: "error"; readonly message: string };

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return "The file diff could not be loaded.";
}

function RawPatchFallback(props: { readonly patch: string; readonly reason?: string }) {
  return (
    <ScrollView className="flex-1 bg-sheet" contentContainerClassName="px-4 py-4">
      {props.reason ? (
        <Text className="mb-3 text-xs text-foreground-muted">{props.reason}</Text>
      ) : null}
      <ScrollView horizontal showsHorizontalScrollIndicator>
        <NativeText
          selectable
          style={{
            fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
            fontSize: 12,
            lineHeight: 18,
          }}
          className="text-foreground"
        >
          {props.patch || "No textual diff available."}
        </NativeText>
      </ScrollView>
    </ScrollView>
  );
}

export function VersionControlDiffRouteScreen(props: VersionControlDiffRouteScreenProps) {
  const { cwd, file, source } = props.route.params;
  const navigation = useNavigation();
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const api = useVersionControlPanelApi(environmentId);
  const [state, setState] = useState<DiffState>({ status: "loading" });
  const colorScheme = useColorScheme();
  const scheme = colorScheme === "dark" ? "dark" : "light";
  const { nativeReviewDiffStyle } = useAppearanceCodeSurface();

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    void api
      .readFileDiff({
        cwd,
        path: file.path,
        ...(file.originalPath ? { originalPath: file.originalPath } : {}),
        source,
      })
      .then((result) => {
        if (!cancelled) setState({ status: "loaded", patch: result.patch });
      })
      .catch((cause) => {
        if (!cancelled && !(cause instanceof VersionControlCommandInterrupted)) {
          setState({ status: "error", message: errorMessage(cause) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, cwd, file.originalPath, file.path, source]);

  const patch = state.status === "loaded" ? state.patch : "";
  const cacheKey = `${cwd}:${file.path}:${JSON.stringify(source)}`;
  const parsedDiff = useMemo(() => buildReviewParsedDiff(patch, cacheKey), [cacheKey, patch]);
  const nativeData = useMemo(
    () => getCachedNativeReviewDiffData({ parsedDiff, comments: EMPTY_COMMENTS }),
    [parsedDiff],
  );
  const NativeReviewDiffView = resolveNativeReviewDiffView();
  const bridge = useNativeReviewDiffBridge({
    threadKey: "version-control",
    sectionId: cacheKey,
    diff: patch,
    data: nativeData,
    scheme,
    collapsedFileIds: EMPTY_IDS,
    viewedFileIds: EMPTY_IDS,
    selectedRowIds: EMPTY_IDS,
    canHighlight: NativeReviewDiffView !== null && parsedDiff.kind === "files",
  });

  return (
    <>
      <NativeStackScreenOptions options={{ title: file.path }} />
      <NativeHeaderToolbar placement="left">
        <NativeHeaderToolbar.Button
          accessibilityLabel="Back to Version Control"
          icon="chevron.left"
          onPress={() => navigation.goBack()}
          separateBackground
        />
      </NativeHeaderToolbar>
      {state.status === "loading" ? (
        <View className="flex-1 bg-sheet px-6 py-8">
          <EmptyState title="Loading diff…" detail={file.path} />
        </View>
      ) : state.status === "error" ? (
        <View className="flex-1 bg-sheet px-6 py-8">
          <EmptyState title="Diff unavailable" detail={state.message} />
        </View>
      ) : parsedDiff.kind === "files" && NativeReviewDiffView ? (
        <View className="flex-1" style={{ backgroundColor: bridge.theme.background }}>
          <NativeReviewDiffView
            collapsable={false}
            testID="version-control-native-diff-view"
            style={StyleSheet.absoluteFill}
            appearanceScheme={scheme}
            collapsedFileIdsJson={bridge.collapsedFileIdsJson}
            collapsedCommentIdsJson={bridge.collapsedCommentIdsJson}
            contentResetKey={cacheKey}
            contentWidth={NATIVE_REVIEW_DIFF_CONTENT_WIDTH}
            rowHeight={nativeReviewDiffStyle.rowHeight}
            rowsJson={bridge.rowsJson}
            selectedRowIdsJson={bridge.selectedRowIdsJson}
            styleJson={bridge.styleJson}
            themeJson={bridge.themeJson}
            tokensPatchJson={bridge.tokensPatchJson}
            tokensResetKey={bridge.tokensResetKey}
            viewedFileIdsJson={bridge.viewedFileIdsJson}
            onDebug={bridge.onDebug}
            onToggleComment={bridge.onToggleComment}
          />
        </View>
      ) : (
        <RawPatchFallback
          patch={state.patch}
          reason={parsedDiff.kind === "raw" ? parsedDiff.reason : undefined}
        />
      )}
    </>
  );
}
