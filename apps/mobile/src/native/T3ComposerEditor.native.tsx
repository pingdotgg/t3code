import { collectComposerInlineTokens } from "@t3tools/shared/composerInlineTokens";
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
import { Image, StyleSheet } from "react-native";

import { markdownFileIconSource } from "@t3tools/mobile-markdown-text/file-icons";
import { resolveMarkdownFileIcon } from "@t3tools/mobile-markdown-text/links";
import { MOBILE_TYPOGRAPHY } from "../lib/typography";
import { useNativePaste } from "../lib/useNativePaste";
import { useFontFamily } from "../lib/useFontFamily";
import { useUniwindTheme } from "../lib/useUniwindTheme";
import {
  acknowledgeComposerNativeEvent,
  assumeComposerControlledState,
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
  readonly singleLineCentered: boolean;
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
  const themeJson = JSON.stringify({
    text: theme["--color-foreground"],
    placeholder: theme["--color-placeholder"],
    chipBackground: theme["--color-subtle"],
    chipBorder: theme["--color-border"],
    chipText: theme["--color-foreground"],
    skillBackground: theme["--color-inline-skill-background"],
    skillBorder: theme["--color-inline-skill-border"],
    skillText: theme["--color-inline-skill-foreground"],
    fileTint: theme["--color-icon-muted"],
  });
  const resolvedTextStyle = StyleSheet.flatten(textStyle) ?? {};
  const regularFontFamily = useFontFamily("regular");
  return (
    <TextInputWrapper onPaste={handlePaste} style={[{ minHeight: 0 }, style]}>
      <NativeView
        ref={nativeRef}
        controlledDocumentJson={controlledDocumentJson}
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
        scrollEnabled={props.scrollEnabled ?? true}
        autoFocus={props.autoFocus ?? false}
        autoCorrect={props.autoCorrect ?? true}
        spellCheck={props.spellCheck ?? true}
        style={{ flex: 1, minHeight: 0 }}
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
          forceNativeEventRender((sequence) => sequence + 1);
        }}
        onComposerPasteImages={(event) => onPasteImages?.(event.nativeEvent.uris)}
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
} from "./T3ComposerEditor.types";
