import { useCallback, useMemo, useRef, useState } from "react";
import type { NativeSyntheticEvent } from "react-native";

import { createNativeReviewDiffTheme, type NativeReviewDiffData } from "./nativeReviewDiffAdapter";
import { useAppearanceCodeSurface } from "../settings/appearance/useAppearanceCodeSurface";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { useNativeReviewDiffHighlighting } from "./useNativeReviewDiffHighlighting";
import { buildNativeReviewTokensResetKey } from "./reviewDiffBridgeKeys";
import { useUniwindTheme } from "../../lib/useUniwindTheme";

export { buildNativeReviewTokensResetKey } from "./reviewDiffBridgeKeys";

export function useNativeReviewDiffBridge(input: {
  readonly threadKey: string | null;
  readonly sectionId: string | null;
  readonly diff: string | null | undefined;
  readonly data: NativeReviewDiffData;
  readonly collapsedFileIds: ReadonlyArray<string>;
  readonly viewedFileIds: ReadonlyArray<string>;
  readonly selectedRowIds: ReadonlyArray<string>;
  readonly canHighlight: boolean;
}) {
  const {
    canHighlight,
    collapsedFileIds,
    data,
    diff,
    sectionId,
    selectedRowIds,
    threadKey,
    viewedFileIds,
  } = input;
  const { nativeReviewDiffStyle } = useAppearanceCodeSurface();
  const { themeAppearance: scheme, themeId } = useAppearancePreferences();
  const appTheme = useUniwindTheme();
  const [surfaceGeneration, setSurfaceGeneration] = useState(0);
  const hasMountedContentRef = useRef(false);
  const [collapsedCommentIds, setCollapsedCommentIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const theme = useMemo(
    () => createNativeReviewDiffTheme(scheme, themeId, appTheme),
    [appTheme, scheme, themeId],
  );
  const collapsedFileIdsSet = useMemo(() => new Set(collapsedFileIds), [collapsedFileIds]);
  const rowsJson = useMemo(() => JSON.stringify(data.rows), [data.rows]);
  const collapsedFileIdsJson = useMemo(() => JSON.stringify(collapsedFileIds), [collapsedFileIds]);
  const viewedFileIdsJson = useMemo(() => JSON.stringify(viewedFileIds), [viewedFileIds]);
  const selectedRowIdsJson = useMemo(() => JSON.stringify(selectedRowIds), [selectedRowIds]);
  const collapsedCommentIdsJson = useMemo(
    () => JSON.stringify(Array.from(collapsedCommentIds)),
    [collapsedCommentIds],
  );
  const themeJson = useMemo(() => JSON.stringify(theme), [theme]);
  const styleJson = useMemo(() => JSON.stringify(nativeReviewDiffStyle), [nativeReviewDiffStyle]);
  const tokensResetKey = useMemo(
    () =>
      `${buildNativeReviewTokensResetKey({
        threadKey,
        sectionId,
        scheme,
        diff,
        fileCount: data.files.length,
        rowCount: data.rows.length,
      })}:${surfaceGeneration}`,
    [data.files.length, data.rows.length, diff, scheme, sectionId, surfaceGeneration, threadKey],
  );
  const { acknowledgeTokenPatch, rejectTokenPatch, tokensPatchJson, updateVisibleRange } =
    useNativeReviewDiffHighlighting({
      files: data.files,
      rows: data.rows,
      collapsedFileIds: collapsedFileIdsSet,
      scheme,
      resetKey: tokensResetKey,
      enabled: canHighlight,
    });

  const onDebug = useCallback(
    (event: NativeSyntheticEvent<Record<string, unknown>>) => {
      const payload = event.nativeEvent;
      const message = payload.message;
      if (message === "surface-content-mounted") {
        // The initial content already has a fresh hook; replacements lose accepted tokens.
        if (hasMountedContentRef.current) setSurfaceGeneration((generation) => generation + 1);
        hasMountedContentRef.current = true;
      }
      if (message === "tokens-patch-delivered") acknowledgeTokenPatch(payload);
      if (message === "tokens-patch-failed") rejectTokenPatch(payload);
      if (
        (message === "draw-metrics" || message === "visible-range") &&
        typeof payload.firstRowIndex === "number" &&
        typeof payload.lastRowIndex === "number"
      ) {
        updateVisibleRange({
          firstRowIndex: payload.firstRowIndex,
          lastRowIndex: payload.lastRowIndex,
        });
      }
    },
    [acknowledgeTokenPatch, rejectTokenPatch, updateVisibleRange],
  );

  const onToggleComment = useCallback(
    (event: NativeSyntheticEvent<{ readonly commentId?: string }>) => {
      const { commentId } = event.nativeEvent;
      if (!commentId) {
        return;
      }

      setCollapsedCommentIds((current) => {
        const next = new Set(current);
        if (next.has(commentId)) {
          next.delete(commentId);
        } else {
          next.add(commentId);
        }
        return next;
      });
    },
    [],
  );

  return {
    themeId,
    theme,
    rowsJson,
    collapsedFileIdsJson,
    collapsedCommentIdsJson,
    viewedFileIdsJson,
    selectedRowIdsJson,
    themeJson,
    styleJson,
    tokensPatchJson,
    tokensResetKey,
    onDebug,
    onToggleComment,
  };
}
