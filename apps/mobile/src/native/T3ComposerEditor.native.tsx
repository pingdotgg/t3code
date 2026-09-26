import { PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES } from "@t3tools/client-runtime/text-paste";
import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@t3tools/contracts";
import { collectComposerInlineTokens } from "@t3tools/shared/composerInlineTokens";
import { composerContextEditorTokens } from "../lib/composerContext";
import { requireNativeView } from "expo";
import { TextInputWrapper } from "expo-paste-input";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import type { NativeSyntheticEvent, ViewProps } from "react-native";
import { Image, Platform, StyleSheet } from "react-native";

import { markdownFileIconSource } from "@t3tools/mobile-markdown-text/file-icons";
import {
  composerChipSizeSuffix,
  contextChipPresentation,
} from "@t3tools/mobile-markdown-text/markdown";
import { resolveMarkdownFileIcon } from "@t3tools/mobile-markdown-text/links";
import { MOBILE_TYPOGRAPHY } from "../lib/typography";
import { useNativePaste } from "../lib/useNativePaste";
import { useFontFamily } from "../lib/useFontFamily";
import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { useUniwindTheme } from "../lib/useUniwindTheme";
import { createNativeComposerTheme } from "../lib/nativeComposerTheme";
import {
  acknowledgeComposerNativeEvent,
  assumeComposerControlledState,
  isComposerNativeEcho,
  pruneAcknowledgedComposerNativeEvents,
  resolveComposerControlledEventCount,
  type ComposerNativeEventSnapshot,
} from "./composerEditorRevision";
import { useComposerEditorAutoHeight } from "./useComposerEditorAutoHeight";
import type { ComposerEditorProps, ComposerEditorSelection } from "./T3ComposerEditor.types";

const NATIVE_MODULE_NAME = "T3ComposerEditor";
const EMPTY_SKILLS: NonNullable<ComposerEditorProps["skills"]> = [];

type NativeEditorEvent = NativeSyntheticEvent<{
  readonly value: string;
  readonly selection: ComposerEditorSelection;
  readonly eventCount: number;
}>;

type NativeSelectionEvent = NativeSyntheticEvent<{
  readonly value: string;
  readonly selection: ComposerEditorSelection;
  readonly eventCount: number;
}>;

type NativePasteImagesEvent = NativeSyntheticEvent<{
  readonly uris: ReadonlyArray<string>;
}>;

type NativePasteTextEvent = NativeSyntheticEvent<{
  readonly value: string;
  readonly eventCount: number;
  readonly text: string;
  readonly selection: ComposerEditorSelection;
}>;

interface NativeComposerEditorRef {
  focus: () => Promise<void>;
  blur: () => Promise<void>;
  setSelection: (start: number, end: number) => Promise<void>;
}

interface NativeComposerEditorProps extends ViewProps {
  readonly ref?: Ref<NativeComposerEditorRef>;
  readonly controlledDocumentJson: string;
  readonly clipboardFragment: string;
  readonly themeJson: string;
  readonly placeholder: string;
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly contentInsetVertical: number;
  readonly singleLineCentered: boolean;
  readonly editable: boolean;
  readonly readOnly: boolean;
  readonly scrollEnabled: boolean;
  readonly autoFocus: boolean;
  readonly autoCorrect: boolean;
  readonly spellCheck: boolean;
  /** Native text-change handler. */
  readonly onComposerChange: (event: NativeEditorEvent) => void;
  /** Native caret-move handler. */
  readonly onComposerSelectionChange?: (event: NativeSelectionEvent) => void;
  /** Native image-paste handler. */
  readonly onComposerPasteImages?: (event: NativePasteImagesEvent) => void;
  /** Native chip-press handler. */
  readonly onComposerContextPress?: (
    event: NativeSyntheticEvent<{ source: string; start: number; end: number }>,
  ) => void;
  /** Native T3-context clipboard paste handler. */
  readonly onComposerPasteContext?: (
    event: NativePasteTextEvent & NativeSyntheticEvent<{ fragment: string; html: string }>,
  ) => void;
  readonly textPasteThresholdBytes: number;
  readonly maxInputChars: number;
  /** Native clipboard text paste handler. */
  readonly onComposerPasteText?: (event: NativePasteTextEvent) => void;
  /** Native focus handler. */
  readonly onComposerFocus?: () => void;
  /** Native blur handler. */
  readonly onComposerBlur?: () => void;
  /** Native content-height handler used for auto-height layout. */
  readonly onComposerContentSizeChange?: (
    event: NativeSyntheticEvent<{ readonly height: number }>,
  ) => void;
}

const NativeView = requireNativeView<NativeComposerEditorProps>(NATIVE_MODULE_NAME);

/** Last path segment for mention chip labels. */
function basename(path: string): string {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separator >= 0 ? path.slice(separator + 1) : path;
}

/** Resolve a markdown file icon URI for mention chips. */
function fileIconUri(path: string): string {
  return Image.resolveAssetSource(markdownFileIconSource(resolveMarkdownFileIcon(path))).uri;
}

/** Native composer that sizes to content and forwards caret-safe layout to the host view. */
export function ComposerEditor({
  ref,
  skills = EMPTY_SKILLS,
  selection,
  style,
  textStyle,
  onChangeText,
  onSelectionChange,
  onPasteImages,
  onPasteText,
  onFocus,
  onBlur,
  contentInsetVertical = 0,
  ...props
}: ComposerEditorProps) {
  const nativeRef = useRef<NativeComposerEditorRef>(null);
  const mostRecentEventCountRef = useRef(0);
  const [mostRecentEventCount, setMostRecentEventCount] = useState(0);
  const [, forceNativeEventRender] = useState(0);
  // The native editor mounts empty, so the snapshot history starts empty: the
  // first controlled payload must be a non-echo so a restored draft (or a
  // recycled native view) is applied rather than skipped.
  const nativeEventSnapshotsRef = useRef<ComposerNativeEventSnapshot[]>([]);
  const [initialConfirmedTokens] = useState(() => collectComposerInlineTokens(props.value));
  const confirmedTokensRef = useRef(initialConfirmedTokens);
  const theme = useUniwindTheme();
  const handlePaste = useNativePaste((uris) => onPasteImages?.(uris));

  useImperativeHandle(
    ref,
    () => ({
      focus: () => void nativeRef.current?.focus(),
      blur: () => void nativeRef.current?.blur(),
      setSelection: (nextSelection) =>
        void nativeRef.current?.setSelection(nextSelection.start, nextSelection.end),
    }),
    [],
  );

  const skillLabels = useMemo(
    () => new Map(skills.map((skill) => [skill.name, skill.displayName?.trim() || skill.name])),
    [skills],
  );
  const tokensJson = useMemo(() => {
    const tokens = collectComposerInlineTokens(props.value, {
      preserveTrailingFrom: confirmedTokensRef.current,
    });
    confirmedTokensRef.current = tokens;
    return JSON.stringify(
      composerContextEditorTokens(props.value, tokens).map((token) => {
        const record =
          token.type === "context"
            ? props.context?.records.find((record) => record.contextId === token.contextId)
            : undefined;
        return {
          type: token.type,
          source: token.source,
          start: token.start,
          end: token.end,
          ...contextChipPresentation(token.type === "context" ? token.kind : token.type, record),
          label:
            token.type === "skill"
              ? (skillLabels.get(token.value) ?? token.value)
              : token.type === "context"
                ? `${token.label}${props.context?.records.some((record) => record.contextId === token.contextId) ? "" : " · unavailable"}`
                : basename(token.value),
          detail: token.type === "context" ? composerChipSizeSuffix(record) : "",
          // Only a mention wears per-filetype artwork. An attachment chip keeps the tinted
          // monochrome glyph web draws for it: coloured artwork ignores the chip's accent and
          // makes the composer chip read differently from the same chip in a sent message.
          iconUri:
            token.type === "mention"
              ? fileIconUri(token.value)
              : record?.kind === "mention" && "path" in record
                ? fileIconUri(record.path)
                : null,
        };
      }),
    );
  }, [props.value, props.context, skillLabels]);
  // Every render resolves against the snapshot history, so a render whose
  // (value, selection) lags the acknowledged native state is stamped behind
  // the native revision and rejected by the editor instead of re-applying a
  // stale caret or stale text mid-typing.
  const controlledEventCount = resolveComposerControlledEventCount(
    props.value,
    selection ?? null,
    mostRecentEventCount,
    nativeEventSnapshotsRef.current,
  );
  const acknowledgesLatestNativeEvent = isComposerNativeEcho(
    props.value,
    selection ?? null,
    mostRecentEventCount,
    nativeEventSnapshotsRef.current,
  );
  const isNativeEcho =
    controlledEventCount === mostRecentEventCount && acknowledgesLatestNativeEvent;
  const controlledDocumentJson = JSON.stringify({
    value: props.value,
    selection: isNativeEcho ? null : (selection ?? null),
    tokensJson,
    mostRecentEventCount: controlledEventCount,
    isNativeEcho,
  });
  useEffect(() => {
    if (!acknowledgesLatestNativeEvent) return;
    nativeEventSnapshotsRef.current = pruneAcknowledgedComposerNativeEvents(
      nativeEventSnapshotsRef.current,
      mostRecentEventCount,
    );
  }, [acknowledgesLatestNativeEvent, mostRecentEventCount]);
  const assumedValue = props.value;
  useEffect(() => {
    // A native event that arrived after this render was committed moves the
    // acknowledged revision forward; the editor rejects this payload, so the
    // snapshot history must not assume it applied.
    if (isNativeEcho || controlledEventCount !== mostRecentEventCountRef.current) return;
    nativeEventSnapshotsRef.current = assumeComposerControlledState(
      nativeEventSnapshotsRef.current,
      controlledEventCount,
      assumedValue,
    );
  }, [assumedValue, controlledEventCount, isNativeEcho, controlledDocumentJson]);
  const acceptNativeEvent = useCallback(
    (eventCount: number, value: string, nextSelection: ComposerEditorSelection) => {
      const acknowledgedEventCount = acknowledgeComposerNativeEvent(
        mostRecentEventCountRef.current,
        eventCount,
      );
      if (acknowledgedEventCount === null) {
        return false;
      }
      mostRecentEventCountRef.current = acknowledgedEventCount;
      nativeEventSnapshotsRef.current.push({
        eventCount: acknowledgedEventCount,
        value,
        selection: nextSelection,
      });
      return acknowledgedEventCount;
    },
    [],
  );
  const { systemColorsActive } = useAppearancePreferences();
  const themeJson = JSON.stringify({
    ...createNativeComposerTheme(theme),
    selection: Platform.OS === "android" || systemColorsActive ? theme["--color-focus"] : null,
  });
  const resolvedTextStyle = StyleSheet.flatten(textStyle) ?? {};
  const regularFontFamily = useFontFamily("regular");
  const { onContentHeight, resolvedStyle } = useComposerEditorAutoHeight(style);
  /** Forward native content-height events into the auto-height hook. */
  function onNativeContentSizeChange(
    event: NativeSyntheticEvent<{ readonly height: number }>,
  ) {
    onContentHeight(event.nativeEvent.height);
  }
  /** Publish native text changes into the controlled React state. */
  function handleComposerChange(event: NativeEditorEvent) {
    const acknowledgedEventCount = acceptNativeEvent(
      event.nativeEvent.eventCount,
      event.nativeEvent.value,
      event.nativeEvent.selection,
    );
    if (acknowledgedEventCount === false) return;
    onChangeText(event.nativeEvent.value);
    onSelectionChange?.(event.nativeEvent.selection);
    setMostRecentEventCount(acknowledgedEventCount);
    forceNativeEventRender(incrementRenderSequence);
  }
  /** Bump the native-event render token after acknowledging an edit. */
  function incrementRenderSequence(sequence: number): number {
    return sequence + 1;
  }
  /** Publish native caret moves into the controlled React state. */
  function handleComposerSelectionChange(event: NativeSelectionEvent) {
    const acknowledgedEventCount = acceptNativeEvent(
      event.nativeEvent.eventCount,
      event.nativeEvent.value,
      event.nativeEvent.selection,
    );
    if (acknowledgedEventCount === false) return;
    // Android emits the selection change mid-mutation, before the change
    // event, so the payload can carry post-edit text. It must reach the
    // parent alongside the acknowledged revision, or the next render
    // stamps the stale draft at that revision and can re-apply it over
    // the newer native text.
    if (event.nativeEvent.value !== props.value) {
      onChangeText(event.nativeEvent.value);
    }
    onSelectionChange?.(event.nativeEvent.selection);
    setMostRecentEventCount(acknowledgedEventCount);
    forceNativeEventRender(incrementRenderSequence);
  }
  /** Forward native image-paste URIs to the host. */
  function handleComposerPasteImages(event: NativePasteImagesEvent) {
    onPasteImages?.(event.nativeEvent.uris);
  }
  /** Forward a native chip press to the host. */
  function handleComposerContextPress(
    event: NativeSyntheticEvent<{ source: string; start: number; end: number }>,
  ) {
    props.onContextPress?.(event.nativeEvent);
  }
  /** Apply a native T3-context paste and notify the host. */
  function handleComposerPasteContext(
    event: NativePasteTextEvent & NativeSyntheticEvent<{ fragment: string; html: string }>,
  ) {
    const paste = event.nativeEvent;
    const acknowledgedEventCount = acceptNativeEvent(
      paste.eventCount,
      paste.value,
      paste.selection,
    );
    if (acknowledgedEventCount === false) return;
    onChangeText(paste.value);
    onSelectionChange?.(paste.selection);
    props.onPasteContext?.(paste);
    setMostRecentEventCount(acknowledgedEventCount);
    forceNativeEventRender(incrementRenderSequence);
  }
  /** Apply a native clipboard text paste and notify the host. */
  function handleComposerPasteText(event: NativePasteTextEvent) {
    const paste = event.nativeEvent;
    const acknowledgedEventCount = acceptNativeEvent(
      paste.eventCount,
      paste.value,
      paste.selection,
    );
    if (acknowledgedEventCount === false) return;
    // Synchronize the draft before an async paste captures its insertion target.
    // React props can still precede the last native keystroke.
    onChangeText(paste.value);
    onSelectionChange?.(paste.selection);
    onPasteText?.(paste);
    setMostRecentEventCount(acknowledgedEventCount);
    forceNativeEventRender(incrementRenderSequence);
  }
  return (
    <TextInputWrapper onPaste={handlePaste} style={[{ minHeight: 0 }, resolvedStyle]}>
      <NativeView
        ref={nativeRef}
        controlledDocumentJson={controlledDocumentJson}
        clipboardFragment={props.clipboardFragment ?? ""}
        themeJson={themeJson}
        placeholder={props.placeholder ?? ""}
        fontFamily={
          typeof resolvedTextStyle.fontFamily === "string"
            ? resolvedTextStyle.fontFamily
            : regularFontFamily
        }
        fontSize={
          typeof resolvedTextStyle.fontSize === "number"
            ? resolvedTextStyle.fontSize
            : MOBILE_TYPOGRAPHY.body.fontSize
        }
        lineHeight={
          typeof resolvedTextStyle.lineHeight === "number"
            ? resolvedTextStyle.lineHeight
            : MOBILE_TYPOGRAPHY.body.lineHeight
        }
        contentInsetVertical={contentInsetVertical}
        singleLineCentered={props.singleLineCentered ?? false}
        editable={props.editable ?? true}
        readOnly={props.readOnly ?? false}
        scrollEnabled={props.scrollEnabled ?? true}
        autoFocus={props.autoFocus ?? false}
        autoCorrect={props.autoCorrect ?? true}
        spellCheck={props.spellCheck ?? true}
        textPasteThresholdBytes={onPasteText ? PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES : 0}
        maxInputChars={PROVIDER_SEND_TURN_MAX_INPUT_CHARS}
        style={{ flex: 1, minHeight: 0 }}
        onComposerContentSizeChange={onNativeContentSizeChange}
        onComposerChange={handleComposerChange}
        onComposerSelectionChange={handleComposerSelectionChange}
        onComposerPasteImages={handleComposerPasteImages}
        onComposerContextPress={handleComposerContextPress}
        onComposerPasteContext={handleComposerPasteContext}
        onComposerPasteText={handleComposerPasteText}
        onComposerFocus={onFocus}
        onComposerBlur={onBlur}
      />
    </TextInputWrapper>
  );
}

export type {
  ComposerEditorHandle,
  ComposerEditorProps,
  ComposerEditorSelection,
  ComposerTextPaste,
} from "./T3ComposerEditor.types";
