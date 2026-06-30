import { collectComposerInlineTokens } from "@t3tools/shared/composerInlineTokens";
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
import { Image, StyleSheet } from "react-native";

import { markdownFileIconSource } from "@t3tools/mobile-markdown-text/file-icons";
import { resolveMarkdownFileIcon } from "@t3tools/mobile-markdown-text/links";
import { MOBILE_TYPOGRAPHY } from "../lib/typography";
import { useThemeColor } from "../lib/useThemeColor";
import {
  acknowledgeComposerNativeEvent,
  isComposerNativeEcho,
  pruneAcknowledgedComposerNativeEvents,
  resolveComposerControlledEventCount,
  type ComposerNativeEventSnapshot,
} from "./composerEditorRevision";
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

interface NativeComposerEditorRef {
  focus: () => Promise<void>;
  blur: () => Promise<void>;
  setSelection: (start: number, end: number) => Promise<void>;
}

interface NativeComposerEditorProps extends ViewProps {
  readonly ref?: Ref<NativeComposerEditorRef>;
  readonly controlledDocumentJson: string;
  readonly themeJson: string;
  readonly placeholder: string;
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly contentInsetVertical: number;
  readonly editable: boolean;
  readonly scrollEnabled: boolean;
  readonly autoFocus: boolean;
  readonly autoCorrect: boolean;
  readonly spellCheck: boolean;
  readonly onComposerChange: (event: NativeEditorEvent) => void;
  readonly onComposerSelectionChange?: (event: NativeSelectionEvent) => void;
  readonly onComposerPasteImages?: (event: NativePasteImagesEvent) => void;
  readonly onComposerFocus?: () => void;
  readonly onComposerBlur?: () => void;
}

const NativeView = requireNativeView<NativeComposerEditorProps>(NATIVE_MODULE_NAME);

function basename(path: string): string {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separator >= 0 ? path.slice(separator + 1) : path;
}

function fileIconUri(path: string): string {
  return Image.resolveAssetSource(markdownFileIconSource(resolveMarkdownFileIcon(path))).uri;
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
  onFocus,
  onBlur,
  contentInsetVertical = 0,
  ...props
}: ComposerEditorProps) {
  const nativeRef = useRef<NativeComposerEditorRef>(null);
  const mostRecentEventCountRef = useRef(0);
  const [mostRecentEventCount, setMostRecentEventCount] = useState(0);
  const [nativeEventSequence, setNativeEventSequence] = useState(0);
  const previousRenderedEventSequenceRef = useRef(0);
  const nativeEventSnapshotsRef = useRef<ComposerNativeEventSnapshot[]>([
    { eventCount: 0, value: props.value, selection: selection ?? null },
  ]);
  const confirmedTokensRef = useRef(collectComposerInlineTokens(props.value));
  const textColor = useThemeColor("--color-foreground");
  const placeholderColor = useThemeColor("--color-placeholder");
  const chipBackground = useThemeColor("--color-subtle");
  const chipBorder = useThemeColor("--color-border");
  const chipText = useThemeColor("--color-foreground");
  const skillBackground = useThemeColor("--color-inline-skill-background");
  const skillBorder = useThemeColor("--color-inline-skill-border");
  const skillText = useThemeColor("--color-inline-skill-foreground");
  const fileTint = useThemeColor("--color-icon-muted");

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
      tokens.map((token) => ({
        type: token.type,
        source: token.source,
        start: token.start,
        end: token.end,
        label:
          token.type === "skill"
            ? (skillLabels.get(token.value) ?? token.value)
            : basename(token.value),
        iconUri: token.type === "mention" ? fileIconUri(token.value) : null,
      })),
    );
  }, [props.value, skillLabels]);
  const includesNativeEvent = nativeEventSequence !== previousRenderedEventSequenceRef.current;
  const controlledEventCount = includesNativeEvent
    ? resolveComposerControlledEventCount(
        props.value,
        selection ?? null,
        mostRecentEventCount,
        nativeEventSnapshotsRef.current,
      )
    : mostRecentEventCount;
  const acknowledgesLatestNativeEvent = isComposerNativeEcho(
    props.value,
    selection ?? null,
    mostRecentEventCount,
    nativeEventSnapshotsRef.current,
  );
  const isNativeEcho =
    includesNativeEvent &&
    controlledEventCount === mostRecentEventCount &&
    acknowledgesLatestNativeEvent;
  const controlledDocumentJson = JSON.stringify({
    value: props.value,
    selection: isNativeEcho ? null : (selection ?? null),
    tokensJson,
    mostRecentEventCount: controlledEventCount,
    isNativeEcho,
  });
  useEffect(() => {
    previousRenderedEventSequenceRef.current = nativeEventSequence;
  }, [nativeEventSequence]);
  useEffect(() => {
    if (!acknowledgesLatestNativeEvent) return;
    nativeEventSnapshotsRef.current = pruneAcknowledgedComposerNativeEvents(
      nativeEventSnapshotsRef.current,
      mostRecentEventCount,
    );
  }, [acknowledgesLatestNativeEvent, mostRecentEventCount]);
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
  const themeJson = JSON.stringify({
    text: String(textColor),
    placeholder: String(placeholderColor),
    chipBackground: String(chipBackground),
    chipBorder: String(chipBorder),
    chipText: String(chipText),
    skillBackground: String(skillBackground),
    skillBorder: String(skillBorder),
    skillText: String(skillText),
    fileTint: String(fileTint),
  });
  const resolvedTextStyle = StyleSheet.flatten(textStyle) ?? {};
  return (
    <NativeView
      ref={nativeRef}
      controlledDocumentJson={controlledDocumentJson}
      themeJson={themeJson}
      placeholder={props.placeholder ?? ""}
      fontFamily={
        typeof resolvedTextStyle.fontFamily === "string"
          ? resolvedTextStyle.fontFamily
          : "DMSans_400Regular"
      }
      fontSize={
        typeof resolvedTextStyle.fontSize === "number"
          ? resolvedTextStyle.fontSize
          : MOBILE_TYPOGRAPHY.composer.fontSize
      }
      lineHeight={
        typeof resolvedTextStyle.lineHeight === "number"
          ? resolvedTextStyle.lineHeight
          : MOBILE_TYPOGRAPHY.composer.lineHeight
      }
      contentInsetVertical={contentInsetVertical}
      editable={props.editable ?? true}
      scrollEnabled={props.scrollEnabled ?? true}
      autoFocus={props.autoFocus ?? false}
      autoCorrect={props.autoCorrect ?? true}
      spellCheck={props.spellCheck ?? true}
      style={style as StyleProp<ViewStyle>}
      onComposerChange={(event: NativeEditorEvent) => {
        const acknowledgedEventCount = acceptNativeEvent(
          event.nativeEvent.eventCount,
          event.nativeEvent.value,
          event.nativeEvent.selection,
        );
        if (acknowledgedEventCount === false) return;
        onChangeText(event.nativeEvent.value);
        onSelectionChange?.(event.nativeEvent.selection);
        setMostRecentEventCount(acknowledgedEventCount);
        setNativeEventSequence((sequence) => sequence + 1);
      }}
      onComposerSelectionChange={(event: NativeSelectionEvent) => {
        const acknowledgedEventCount = acceptNativeEvent(
          event.nativeEvent.eventCount,
          event.nativeEvent.value,
          event.nativeEvent.selection,
        );
        if (acknowledgedEventCount === false) return;
        onSelectionChange?.(event.nativeEvent.selection);
        setMostRecentEventCount(acknowledgedEventCount);
        setNativeEventSequence((sequence) => sequence + 1);
      }}
      onComposerPasteImages={(event: NativePasteImagesEvent) =>
        onPasteImages?.(event.nativeEvent.uris)
      }
      onComposerFocus={onFocus}
      onComposerBlur={onBlur}
    />
  );
}

export type {
  ComposerEditorHandle,
  ComposerEditorProps,
  ComposerEditorSelection,
} from "./T3ComposerEditor.types";
