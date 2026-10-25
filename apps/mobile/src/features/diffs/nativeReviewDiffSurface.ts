import {
  createElement,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ComponentType,
  type Ref,
} from "react";
import { View, type NativeSyntheticEvent, type ViewProps } from "react-native";
import { requireNativeView } from "expo";

import { EmptyState } from "../../components/ui/EmptyState";
import { NativeViewResolutionError } from "../../native/nativeViewResolutionError";

const NATIVE_REVIEW_DIFF_MODULE_NAME = "T3ReviewDiffSurface";
const NATIVE_REVIEW_DIFF_PAYLOAD_RETRY_FRAMES = 60;

interface ExpoGlobalWithViewConfig {
  readonly expo?: {
    getViewConfig?: (moduleName: string, viewName?: string) => unknown;
  };
}

export interface NativeReviewDiffRow {
  readonly kind: "file" | "hunk" | "line" | "notice" | "comment";
  readonly id: string;
  readonly fileId?: string;
  readonly filePath?: string;
  readonly previousPath?: string | null;
  readonly changeType?:
    | "modified"
    | "new"
    | "deleted"
    | "renamed"
    | "rename-pure"
    | "rename-changed";
  readonly additions?: number;
  readonly deletions?: number;
  readonly text?: string;
  readonly content?: string;
  readonly change?: "context" | "add" | "delete";
  readonly oldLineNumber?: number | null;
  readonly newLineNumber?: number | null;
  readonly wordDiffRanges?: ReadonlyArray<NativeReviewDiffWordDiffRange>;
  readonly commentText?: string;
  readonly commentRangeLabel?: string;
  readonly commentSectionTitle?: string;
}

export interface NativeReviewDiffWordDiffRange {
  readonly start: number;
  readonly end: number;
}

export interface NativeReviewDiffToken {
  readonly content: string;
  readonly color: string | null;
  readonly fontStyle: number | null;
}

export interface NativeReviewDiffTheme {
  readonly background: string;
  readonly text: string;
  readonly mutedText: string;
  readonly headerBackground: string;
  readonly border: string;
  readonly hunkBackground: string;
  readonly hunkText: string;
  readonly addBackground: string;
  readonly deleteBackground: string;
  readonly addBar: string;
  readonly deleteBar: string;
  readonly addText: string;
  readonly deleteText: string;
}

export interface NativeReviewDiffStyle {
  readonly rowHeight?: number;
  readonly contentWidth?: number;
  readonly changeBarWidth?: number;
  readonly gutterWidth?: number;
  readonly codePadding?: number;
  readonly textVerticalInset?: number;
  readonly fileHeaderHeight?: number;
  readonly fileHeaderHorizontalMargin?: number;
  readonly fileHeaderVerticalMargin?: number;
  readonly fileHeaderCornerRadius?: number;
  readonly fileHeaderHorizontalPadding?: number;
  readonly fileHeaderPathRightPadding?: number;
  readonly fileHeaderCountColumnWidth?: number;
  readonly fileHeaderCountGap?: number;
  readonly codeFontSize?: number;
  readonly codeFontWeight?: string;
  readonly lineNumberFontSize?: number;
  readonly lineNumberFontWeight?: string;
  readonly hunkFontSize?: number;
  readonly hunkFontWeight?: string;
  readonly fileHeaderFontSize?: number;
  readonly fileHeaderFontWeight?: string;
  readonly fileHeaderMetaFontSize?: number;
  readonly fileHeaderMetaFontWeight?: string;
  readonly fileHeaderSubtextFontSize?: number;
  readonly fileHeaderSubtextFontWeight?: string;
  readonly fileHeaderStatusFontSize?: number;
  readonly fileHeaderStatusFontWeight?: string;
  readonly emptyStateFontSize?: number;
  readonly emptyStateFontWeight?: string;
}

export interface NativeReviewDiffViewProps extends ViewProps {
  readonly contentInsetTop?: number;
  readonly contentInsetBottom?: number;
  readonly rowsJson: string;
  readonly tokensJson?: string;
  readonly tokensPatchJson?: string;
  readonly tokensResetKey?: string;
  readonly contentResetKey?: string;
  readonly collapsedFileIdsJson?: string;
  readonly viewedFileIdsJson?: string;
  readonly selectedRowIdsJson?: string;
  readonly collapsedCommentIdsJson?: string;
  readonly appearanceScheme: "light" | "dark";
  readonly themeJson: string;
  readonly styleJson?: string;
  readonly rowHeight: number;
  /** Android ignores this and measures the widest row. */
  readonly contentWidth: number;
  readonly initialRowIndex?: number;
  readonly initialFileId?: string;
  readonly scrollEnabled?: boolean;
  readonly bounces?: boolean;
  readonly refreshing?: boolean;
  readonly nativeViewRef?: Ref<NativeReviewDiffViewHandle>;
  readonly onPullToRefresh?: (event: NativeSyntheticEvent<Record<string, never>>) => void;
  readonly onDebug?: (event: NativeSyntheticEvent<Record<string, unknown>>) => void;
  readonly onVisibleFileChange?: (
    event: NativeSyntheticEvent<{ readonly fileId?: string | null }>,
  ) => void;
  readonly onToggleFile?: (event: NativeSyntheticEvent<{ readonly fileId?: string }>) => void;
  readonly onToggleViewedFile?: (event: NativeSyntheticEvent<{ readonly fileId?: string }>) => void;
  readonly onPressLine?: (
    event: NativeSyntheticEvent<{
      readonly rowId?: string;
      readonly fileId?: string;
      readonly gesture?: "tap" | "longPress";
      readonly oldLineNumber?: number;
      readonly newLineNumber?: number;
      readonly change?: "context" | "add" | "delete";
    }>,
  ) => void;
  readonly onToggleComment?: (event: NativeSyntheticEvent<{ readonly commentId?: string }>) => void;
}

export interface NativeReviewDiffViewHandle {
  readonly scrollToFile: (fileId: string, animated?: boolean) => Promise<void>;
  readonly scrollToTop: (animated?: boolean) => Promise<void>;
}

export function isNativeReviewDiffDrawEvent(payload: Readonly<Record<string, unknown>>): boolean {
  return payload.message === "draw-metrics" || payload.message === "visible-range";
}

interface NativeReviewDiffViewRef {
  readonly setRowsJson: (rowsJson: string) => Promise<void>;
  readonly setTokensJson: (tokensJson: string) => Promise<void>;
  readonly setTokensPatchJson: (tokensPatchJson: string) => Promise<boolean>;
  readonly scrollToFile: (fileId: string, animated: boolean) => Promise<void>;
  readonly scrollToTop: (animated: boolean) => Promise<void>;
}

type NativeReviewDiffRawViewProps = Omit<
  NativeReviewDiffViewProps,
  "nativeViewRef" | "rowsJson" | "tokensJson" | "tokensPatchJson"
> & {
  readonly refreshEnabled: boolean;
  readonly ref?: Ref<NativeReviewDiffViewRef>;
};

let cachedNativeReviewDiffRawView: ComponentType<NativeReviewDiffRawViewProps> | undefined;
let nativeReviewDiffViewResolutionFailed = false;

type NativeReviewDiffPayloadMethod = "setRowsJson" | "setTokensJson" | "setTokensPatchJson";

export function isPendingNativeViewRegistration(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message.includes(`Unable to find the '${NATIVE_REVIEW_DIFF_MODULE_NAME}' view`) ||
    (error.message.includes("Unable to find the class") &&
      error.message.includes("T3ReviewDiffView view with tag"))
  );
}

function useNativeReviewDiffPayload(
  nativeRef: React.RefObject<NativeReviewDiffViewRef | null>,
  method: NativeReviewDiffPayloadMethod,
  payload: string | undefined,
  resetKey?: string,
  onFailure?: () => void,
  onDelivered?: (payload: string) => void,
) {
  useEffect(() => {
    if (payload === undefined) {
      return;
    }

    let cancelled = false;
    let frame: number | null = null;
    let attempts = 0;

    const dispatch = () => {
      if (cancelled) {
        return;
      }

      const view = nativeRef.current;
      const command: ((payload: string) => Promise<void | boolean>) | undefined = view?.[method];
      if (!view || !command) {
        if (attempts < NATIVE_REVIEW_DIFF_PAYLOAD_RETRY_FRAMES) {
          attempts += 1;
          frame = requestAnimationFrame(dispatch);
        } else {
          console.error(`[native-review-diff] ${method} unavailable`);
          onFailure?.();
        }
        return;
      }

      void Promise.resolve()
        .then(() => {
          if (!cancelled) return command.call(view, payload);
        })
        .then((accepted) => {
          if (cancelled) return;
          // This promise resolves after native decode, reset validation, and merge.
          if (method === "setTokensPatchJson" && accepted !== true) {
            throw new Error("Native token patch was not accepted");
          }
          onDelivered?.(payload);
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          if (
            attempts < NATIVE_REVIEW_DIFF_PAYLOAD_RETRY_FRAMES &&
            isPendingNativeViewRegistration(error)
          ) {
            attempts += 1;
            frame = requestAnimationFrame(dispatch);
            return;
          }
          console.error(`[native-review-diff] ${method} failed`, error);
          onFailure?.();
        });
    };

    // Fabric attaches the React ref before Expo registers the native tag used by
    // view functions. Starting on the next frame avoids racing that registration.
    frame = requestAnimationFrame(dispatch);

    return () => {
      cancelled = true;
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
    };
  }, [method, nativeRef, payload, resetKey, onFailure, onDelivered]);
}

function getExpoViewConfig(moduleName: string) {
  return (globalThis as typeof globalThis & ExpoGlobalWithViewConfig).expo?.getViewConfig?.(
    moduleName,
  );
}

function NativeReviewDiffView(props: NativeReviewDiffViewProps) {
  const [failedRowsJson, setFailedRowsJson] = useState<string | null>(null);
  const onRowsFailure = useCallback(() => setFailedRowsJson(props.rowsJson), [props.rowsJson]);
  if (failedRowsJson !== null && failedRowsJson !== props.rowsJson) setFailedRowsJson(null);
  if (failedRowsJson === props.rowsJson) {
    return createElement(
      View,
      {
        style: [
          props.style,
          {
            flex: 1,
            justifyContent: "center",
            paddingTop: props.contentInsetTop,
            paddingBottom: props.contentInsetBottom,
          },
        ],
      },
      createElement(EmptyState, {
        title: "Could not display diff",
        detail: "Try loading the diff view again.",
        variant: "plain",
        actionLabel: "Retry diff",
        onAction: () => {
          props.onDebug?.({
            nativeEvent: { message: "surface-retry" },
          } as unknown as NativeSyntheticEvent<Record<string, unknown>>);
          setFailedRowsJson(null);
        },
      }),
    );
  }
  return createElement(NativeReviewDiffContent, { ...props, onRowsFailure });
}

function NativeReviewDiffContent(
  props: NativeReviewDiffViewProps & { readonly onRowsFailure: () => void },
) {
  const {
    nativeViewRef,
    rowsJson,
    tokensJson,
    tokensPatchJson,
    onRowsFailure,
    onDebug,
    ...nativeProps
  } = props;
  const nativeRef = useRef<NativeReviewDiffViewRef>(null);
  useNativeReviewDiffPayload(
    nativeRef,
    "setRowsJson",
    rowsJson,
    props.contentResetKey,
    onRowsFailure,
  );
  useNativeReviewDiffPayload(nativeRef, "setTokensJson", tokensJson);
  const onDebugRef = useRef(onDebug);
  useEffect(() => {
    onDebugRef.current = onDebug;
  }, [onDebug]);
  const reportedMountRef = useRef(false);
  useEffect(() => {
    // Effect replay keeps the same native content; only a new mount loses tokens.
    if (reportedMountRef.current) return;
    reportedMountRef.current = true;
    onDebugRef.current?.({
      nativeEvent: { message: "surface-content-mounted" },
    } as unknown as NativeSyntheticEvent<Record<string, unknown>>);
  }, []);
  const reportTokenDelivery = useCallback((json: string, message: string) => {
    const patch = JSON.parse(json) as { resetKey?: string; chunkIndex?: number };
    if (patch.chunkIndex === undefined) return;
    onDebugRef.current?.({
      nativeEvent: {
        message,
        resetKey: patch.resetKey,
        chunkIndex: patch.chunkIndex,
      },
    } as unknown as NativeSyntheticEvent<Record<string, unknown>>);
  }, []);
  const onTokensDelivered = useCallback(
    (json: string) => {
      reportTokenDelivery(json, "tokens-patch-delivered");
    },
    [reportTokenDelivery],
  );
  const onTokensFailure = useCallback(() => {
    if (tokensPatchJson !== undefined) reportTokenDelivery(tokensPatchJson, "tokens-patch-failed");
  }, [reportTokenDelivery, tokensPatchJson]);
  useNativeReviewDiffPayload(
    nativeRef,
    "setTokensPatchJson",
    tokensPatchJson,
    undefined,
    onTokensFailure,
    onTokensDelivered,
  );
  useImperativeHandle(
    nativeViewRef,
    () => ({
      scrollToFile: async (fileId, animated = true) => {
        await nativeRef.current?.scrollToFile(fileId, animated);
      },
      scrollToTop: async (animated = true) => {
        await nativeRef.current?.scrollToTop(animated);
      },
    }),
    [],
  );

  const RawNativeView = cachedNativeReviewDiffRawView;
  if (!RawNativeView) {
    return null;
  }

  return createElement(RawNativeView, {
    ...nativeProps,
    refreshEnabled: props.onPullToRefresh !== undefined,
    onDebug: (event) => {
      if (event.nativeEvent.message === "rows-decode-failed") {
        console.error("[native-review-diff] rows decode failed", event.nativeEvent.error);
        onRowsFailure();
      }
      onDebug?.(event);
    },
    ref: nativeRef,
  });
}

export function resolveNativeReviewDiffView(): ComponentType<NativeReviewDiffViewProps> | null {
  if (cachedNativeReviewDiffRawView) {
    return NativeReviewDiffView;
  }

  if (nativeReviewDiffViewResolutionFailed) {
    return null;
  }

  if (getExpoViewConfig(NATIVE_REVIEW_DIFF_MODULE_NAME) == null) {
    return null;
  }

  try {
    cachedNativeReviewDiffRawView = requireNativeView<NativeReviewDiffRawViewProps>(
      NATIVE_REVIEW_DIFF_MODULE_NAME,
    );
  } catch (cause) {
    nativeReviewDiffViewResolutionFailed = true;
    console.error(
      new NativeViewResolutionError({
        nativeModuleName: NATIVE_REVIEW_DIFF_MODULE_NAME,
        cause,
      }),
    );
    return null;
  }

  return cachedNativeReviewDiffRawView ? NativeReviewDiffView : null;
}
