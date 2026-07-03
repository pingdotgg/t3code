import {
  createElement,
  useEffect,
  useImperativeHandle,
  useRef,
  type ComponentType,
  type Ref,
} from "react";
import type { NativeSyntheticEvent, ViewProps } from "react-native";
import { requireNativeView } from "expo";

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
  readonly contentWidth: number;
  readonly initialRowIndex?: number;
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

interface NativeReviewDiffViewRef {
  readonly setRowsJson: (rowsJson: string) => Promise<void>;
  readonly setTokensJson: (tokensJson: string) => Promise<void>;
  readonly setTokensPatchJson: (tokensPatchJson: string) => Promise<void>;
  readonly scrollToFile: (fileId: string, animated: boolean) => Promise<void>;
  readonly scrollToTop: (animated: boolean) => Promise<void>;
}

type NativeReviewDiffRawViewProps = Omit<
  NativeReviewDiffViewProps,
  "nativeViewRef" | "rowsJson" | "tokensJson" | "tokensPatchJson"
> & {
  readonly ref?: Ref<NativeReviewDiffViewRef>;
};

let cachedNativeReviewDiffRawView: ComponentType<NativeReviewDiffRawViewProps> | undefined;
let nativeReviewDiffViewResolutionFailed = false;

type NativeReviewDiffPayloadMethod = "setRowsJson" | "setTokensJson" | "setTokensPatchJson";

export function isPendingNativeViewRegistration(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes(`Unable to find the '${NATIVE_REVIEW_DIFF_MODULE_NAME}' view`)
  );
}

function useNativeReviewDiffPayload(
  nativeRef: React.RefObject<NativeReviewDiffViewRef | null>,
  method: NativeReviewDiffPayloadMethod,
  payload: string | undefined,
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
      const command = view?.[method];
      if (!view || !command) {
        if (attempts < NATIVE_REVIEW_DIFF_PAYLOAD_RETRY_FRAMES) {
          attempts += 1;
          frame = requestAnimationFrame(dispatch);
        }
        return;
      }

      void command.call(view, payload).catch((error: unknown) => {
        if (
          !cancelled &&
          attempts < NATIVE_REVIEW_DIFF_PAYLOAD_RETRY_FRAMES &&
          isPendingNativeViewRegistration(error)
        ) {
          attempts += 1;
          frame = requestAnimationFrame(dispatch);
          return;
        }
        console.error(`[native-review-diff] ${method} failed`, error);
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
  }, [method, nativeRef, payload]);
}

function getExpoViewConfig(moduleName: string) {
  return (globalThis as typeof globalThis & ExpoGlobalWithViewConfig).expo?.getViewConfig?.(
    moduleName,
  );
}

function NativeReviewDiffView(props: NativeReviewDiffViewProps) {
  const { nativeViewRef, rowsJson, tokensJson, tokensPatchJson, ...nativeProps } = props;
  const nativeRef = useRef<NativeReviewDiffViewRef>(null);
  useNativeReviewDiffPayload(nativeRef, "setRowsJson", rowsJson);
  useNativeReviewDiffPayload(nativeRef, "setTokensJson", tokensJson);
  useNativeReviewDiffPayload(nativeRef, "setTokensPatchJson", tokensPatchJson);
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

  return createElement(RawNativeView, { ...nativeProps, ref: nativeRef });
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
