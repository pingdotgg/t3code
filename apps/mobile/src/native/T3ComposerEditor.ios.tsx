import { PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES } from "@t3tools/client-runtime/text-paste";
import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@t3tools/contracts";
import { collectComposerInlineTokens } from "@t3tools/shared/composerInlineTokens";
import { composerContextEditorTokens, composerSkillLabels } from "../lib/composerContext";
import { requireNativeView } from "expo";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import type { NativeSyntheticEvent, StyleProp, ViewProps, ViewStyle } from "react-native";
import { StyleSheet } from "react-native";

import {
  composerChipSizeSuffix,
  contextChipIcon,
  contextChipAccent,
  contextChipPresentation,
  contextRecordFileName,
} from "../lib/composerChipPresentation";
import { contextChipIconUri } from "../lib/contextChipIconSource";
import { useUniwindTheme } from "../lib/useUniwindTheme";
import { createNativeComposerTheme } from "../lib/nativeComposerTheme";
import { FONT_FAMILIES } from "../lib/fontFamilies";
import { useScaledTextRole } from "../features/settings/appearance/useScaledTextRole";
import {
  acknowledgeComposerNativeEvent,
  assumeComposerControlledState,
  isComposerNativeEcho,
  pruneAcknowledgedComposerNativeEvents,
  resolveComposerControlledEventCount,
  type ComposerNativeEventSnapshot,
} from "./composerEditorRevision";
import { DEFAULT_COMPOSER_ENTER_BEHAVIOR } from "../lib/composerEnterBehavior";
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
  readonly editable: boolean;
  readonly readOnly: boolean;
  readonly enterBehavior: string;
  readonly submitTitle: string;
  readonly alternateSubmitTitle: string;
  readonly scrollEnabled: boolean;
  readonly autoFocus: boolean;
  readonly autoCorrect: boolean;
  readonly spellCheck: boolean;
  readonly onComposerChange: (event: NativeEditorEvent) => void;
  readonly onComposerSelectionChange?: (event: NativeSelectionEvent) => void;
  readonly onComposerPasteImages?: (event: NativePasteImagesEvent) => void;
  readonly onComposerContextPress?: (
    event: NativeSyntheticEvent<{ source: string; start: number; end: number }>,
  ) => void;
  readonly onComposerPasteContext?: (
    event: NativePasteTextEvent & NativeSyntheticEvent<{ fragment: string; html: string }>,
  ) => void;
  readonly textPasteThresholdBytes: number;
  readonly maxInputChars: number;
  readonly onComposerPasteText?: (event: NativePasteTextEvent) => void;
  readonly onComposerFocus?: () => void;
  readonly onComposerBlur?: () => void;
  readonly onComposerSubmit?: (event: NativeSyntheticEvent<{ alternate: boolean }>) => void;
  readonly onComposerContentSizeChange?: (
    event: NativeSyntheticEvent<{ readonly width: number; readonly height: number }>,
  ) => void;
}

const NativeView = requireNativeView<NativeComposerEditorProps>(NATIVE_MODULE_NAME);

// A view command rejects with "Unable to find the view" when the composer's native view is
// unmounted, which can happen while an open question hides the composer slot. There is nothing
// to act on then.
function settleViewCommand(command: Promise<void> | undefined): void {
  command?.catch(() => undefined);
}

function basename(path: string): string {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separator >= 0 ? path.slice(separator + 1) : path;
}

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
  onSubmit,
  onContentSizeChange,
  contentInsetVertical = 0,
  ...props
}: ComposerEditorProps) {
  const nativeRef = useRef<NativeComposerEditorRef>(null);
  const mostRecentEventCountRef = useRef(0);
  const [mostRecentEventCount, setMostRecentEventCount] = useState(0);
  const [, forceNativeEventRender] = useState(0);
  // Start history empty so restored drafts or recycled views receive a non-echo controlled payload.
  const nativeEventSnapshotsRef = useRef<ComposerNativeEventSnapshot[]>([]);
  // Tokens advance from the previous committed value; render-phase state keeps
  // an abandoned render from leaking a trailing token into the next one.
  const [confirmedTokens, setConfirmedTokens] = useState(() => ({
    value: props.value,
    tokens: collectComposerInlineTokens(props.value),
  }));
  let tokens = confirmedTokens.tokens;
  if (confirmedTokens.value !== props.value) {
    tokens = collectComposerInlineTokens(props.value, {
      preserveTrailingFrom: confirmedTokens.tokens,
    });
    setConfirmedTokens({ value: props.value, tokens });
  }
  const bodyText = useScaledTextRole("body");
  const theme = useUniwindTheme();
  const fontFamily = FONT_FAMILIES.regular;

  useImperativeHandle(
    ref,
    () => ({
      focus: () => settleViewCommand(nativeRef.current?.focus()),
      blur: () => settleViewCommand(nativeRef.current?.blur()),
      setSelection: (nextSelection) =>
        settleViewCommand(nativeRef.current?.setSelection(nextSelection.start, nextSelection.end)),
    }),
    [],
  );

  const skillLabels = useMemo(() => composerSkillLabels(skills), [skills]);
  const chipTextColor = createNativeComposerTheme(theme).text;
  const tokensJson = useMemo(() => {
    return JSON.stringify(
      composerContextEditorTokens(props.value, tokens, skillLabels).map((token) => {
        const record =
          token.type === "context"
            ? props.context?.records.find((record) => record.contextId === token.contextId)
            : undefined;
        const presentation = contextChipPresentation(
          token.type === "context" ? token.kind : token.type,
          record,
        );
        const icon = contextChipIcon(
          presentation,
          token.type === "mention" ? token.value : contextRecordFileName(record),
        );
        return {
          type: token.type,
          source: token.source,
          start: token.start,
          end: token.end,
          accent: contextChipAccent(presentation.accent, theme, chipTextColor),
          label:
            token.type === "skill"
              ? (skillLabels.get(token.value) ?? token.value)
              : token.type === "context"
                ? `${token.label}${props.context?.records.some((record) => record.contextId === token.contextId) ? "" : " · unavailable"}`
                : basename(token.value),
          detail: token.type === "context" ? composerChipSizeSuffix(record) : "",
          iconUri: contextChipIconUri(icon),
          tintsIcon: icon.kind === "chip",
        };
      }),
    );
  }, [props.value, tokens, props.context, skillLabels, theme, chipTextColor]);
  // Every render resolves against the snapshot history, so a render whose
  // (value, selection) lags the acknowledged native state is stamped behind
  // the native revision and rejected by the editor instead of re-applying a
  // stale caret or stale text mid-typing.
  /* oxlint-disable react/refs -- Native controlled edits must reconcile against the last acknowledged native event before sending the next payload. */
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
  /* oxlint-enable react/refs */
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
  }, [acknowledgesLatestNativeEvent, mostRecentEventCount, nativeEventSnapshotsRef]);
  const assumedValue = props.value;
  useEffect(() => {
    // Newer native events make this payload stale; do not record it as applied.
    if (isNativeEcho || controlledEventCount !== mostRecentEventCountRef.current) return;
    nativeEventSnapshotsRef.current = assumeComposerControlledState(
      nativeEventSnapshotsRef.current,
      controlledEventCount,
      assumedValue,
    );
  }, [
    assumedValue,
    controlledEventCount,
    isNativeEcho,
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Every changed native payload, including selection-only changes, must update the assumed native snapshot.
    controlledDocumentJson,
    nativeEventSnapshotsRef,
  ]);
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
    [nativeEventSnapshotsRef],
  );
  const themeJson = JSON.stringify(createNativeComposerTheme(theme));
  const resolvedTextStyle = StyleSheet.flatten(textStyle) ?? {};
  return (
    <NativeView
      ref={nativeRef}
      controlledDocumentJson={controlledDocumentJson}
      clipboardFragment={props.clipboardFragment ?? ""}
      themeJson={themeJson}
      placeholder={props.placeholder ?? ""}
      fontFamily={
        typeof resolvedTextStyle.fontFamily === "string" ? resolvedTextStyle.fontFamily : fontFamily
      }
      fontSize={
        typeof resolvedTextStyle.fontSize === "number"
          ? resolvedTextStyle.fontSize
          : bodyText.fontSize
      }
      lineHeight={
        typeof resolvedTextStyle.lineHeight === "number"
          ? resolvedTextStyle.lineHeight
          : bodyText.lineHeight
      }
      contentInsetVertical={contentInsetVertical}
      editable={props.editable ?? true}
      readOnly={props.readOnly ?? false}
      enterBehavior={props.enterBehavior ?? DEFAULT_COMPOSER_ENTER_BEHAVIOR}
      submitTitle={props.submitTitle ?? "Send Message"}
      alternateSubmitTitle={props.alternateSubmitTitle ?? props.submitTitle ?? "Send Message"}
      scrollEnabled={props.scrollEnabled ?? true}
      autoFocus={props.autoFocus ?? false}
      autoCorrect={props.autoCorrect ?? true}
      spellCheck={props.spellCheck ?? true}
      textPasteThresholdBytes={onPasteText ? PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES : 0}
      maxInputChars={PROVIDER_SEND_TURN_MAX_INPUT_CHARS}
      style={style as StyleProp<ViewStyle>}
      onComposerChange={(event) => {
        const acknowledgedEventCount = acceptNativeEvent(
          event.nativeEvent.eventCount,
          event.nativeEvent.value,
          event.nativeEvent.selection,
        );
        if (acknowledgedEventCount === false) return;
        onChangeText(event.nativeEvent.value);
        onSelectionChange?.(event.nativeEvent.selection);
        setMostRecentEventCount(acknowledgedEventCount);
        forceNativeEventRender((sequence) => sequence + 1);
      }}
      onComposerSelectionChange={(event) => {
        const acknowledgedEventCount = acceptNativeEvent(
          event.nativeEvent.eventCount,
          event.nativeEvent.value,
          event.nativeEvent.selection,
        );
        if (acknowledgedEventCount === false) return;
        // Selection events may carry post-edit text; publish it with its revision or stale drafts can overwrite native text.
        if (event.nativeEvent.value !== props.value) {
          onChangeText(event.nativeEvent.value);
        }
        onSelectionChange?.(event.nativeEvent.selection);
        setMostRecentEventCount(acknowledgedEventCount);
        forceNativeEventRender((sequence) => sequence + 1);
      }}
      onComposerPasteImages={(event) => onPasteImages?.(event.nativeEvent.uris)}
      onComposerContextPress={(event) => props.onContextPress?.(event.nativeEvent)}
      onComposerPasteContext={(event) => {
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
        forceNativeEventRender((sequence) => sequence + 1);
      }}
      onComposerPasteText={(event) => {
        const paste = event.nativeEvent;
        const acknowledgedEventCount = acceptNativeEvent(
          paste.eventCount,
          paste.value,
          paste.selection,
        );
        if (acknowledgedEventCount === false) return;
        // Sync before capturing async paste targets; props may lag the last native keystroke.
        onChangeText(paste.value);
        onSelectionChange?.(paste.selection);
        onPasteText?.(paste);
        setMostRecentEventCount(acknowledgedEventCount);
        forceNativeEventRender((sequence) => sequence + 1);
      }}
      onComposerFocus={onFocus}
      onComposerBlur={onBlur}
      onComposerContentSizeChange={
        onContentSizeChange === undefined
          ? undefined
          : (event) => onContentSizeChange(event.nativeEvent)
      }
      onComposerSubmit={
        onSubmit === undefined
          ? undefined
          : (event) => onSubmit(event.nativeEvent.alternate === true)
      }
    />
  );
}

export type {
  ComposerEditorHandle,
  ComposerEditorProps,
  ComposerEditorSelection,
  ComposerTextPaste,
} from "./T3ComposerEditor.types";
