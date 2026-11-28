import type { IssueCommentAudience } from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { useRef, useState } from "react";
import { Platform, View } from "react-native";
import Animated from "react-native-reanimated";

import {
  ComposerEditor,
  type ComposerEditorHandle,
  type ComposerEditorSelection,
} from "../../components/ComposerEditor";
import {
  COMPOSER_BOTTOM_GUTTER,
  ComposerSurface,
  INLINE_EDITOR_MIN_WIDTH,
  useCompactComposerEditor,
  useComposerChrome,
  useComposerTextStyle,
} from "../../components/ComposerSurface";
import {
  ComposerActionButton,
  ComposerInlineControl,
  ComposerToolbarRow,
} from "../../components/ComposerToolbar";
import { AppText as Text } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import { useComposerTextRole } from "../settings/appearance/useScaledTextRole";
import {
  ComposerDictationCancelAction,
  ComposerDictationDraftContent,
  ComposerDictationError,
  ComposerDictationPrimaryAction,
  ComposerDictationStartAction,
  ComposerDictationStatus,
  ComposerDictationToolbar,
} from "../voice-input/ComposerDictationControl";
import { useVoiceInputController } from "../voice-input/useVoiceInputController";
import { resolveVoiceComposerPresentation } from "../voice-input/voiceInputPresentation";

// The thread composer's editor starts after its attachment button; this keeps the same text inset.
const EDITOR_LEADING_INSET = 14;

/**
 * The comment box at the foot of an issue, in the thread composer's chrome: one row that grows
 * with the draft, dictation, and a round send button. With audiences, the editor gets its own two
 * lines above the audience menu and send. `blocked` replaces the editor with the reason.
 */
export function IssueCommentComposer(props: {
  /** Names this draft to dictation, so a recording started here lands here. */
  readonly ownerKey: string;
  readonly label: string;
  readonly blocked: string | null;
  readonly posting: boolean;
  /** Each comment is an internal note unless the viewer picks a reply to the customer. */
  readonly audiences: boolean;
  readonly bottomInset: number;
  readonly contentMaxWidth?: number;
  /** Resolves true once the comment is posted, which clears the draft. */
  readonly onSubmit: (body: string, audience?: IssueCommentAudience) => Promise<boolean>;
  readonly onHeightChange: (height: number) => void;
  readonly onFocusChange: (focused: boolean) => void;
}) {
  const gt = useGT();
  // Internal by default: a customer reply is always an explicit choice.
  const [audience, setAudience] = useState<IssueCommentAudience>("internal");
  const editorRef = useRef<ComposerEditorHandle>(null);
  const [draft, setDraft] = useState("");
  // Read by dictation and by send after an await, when the render's `draft` may be stale.
  const latestDraft = useRef(draft);
  const changeDraft = (text: string) => {
    latestDraft.current = text;
    setDraft(text);
  };
  const [selection, setSelection] = useState<ComposerEditorSelection>({ start: 0, end: 0 });
  const bodyText = useComposerTextRole();
  const textStyle = useComposerTextStyle(bodyText);
  const chrome = useComposerChrome();
  const [focused, setFocused] = useState(false);
  // Animate only while typing, as the thread composer does; a restored draft lands in place.
  const compactEditor = useCompactComposerEditor(bodyText, draft, Platform.OS === "ios" && focused);
  const [contentHeight, setContentHeight] = useState(0);
  const twoLineEditorHeight = Math.max(
    bodyText.lineHeight * 2,
    Math.min(bodyText.lineHeight * 4, draft.length === 0 ? 0 : contentHeight),
  );
  const voiceInput = useVoiceInputController({
    ownerKey: props.ownerKey,
    label: props.label,
    readDraftMessage: () => latestDraft.current,
    selection,
    disabled: props.blocked !== null,
    hidden: props.blocked !== null,
    onChangeDraftMessage: changeDraft,
    onChangeSelection: setSelection,
  });
  const voicePresentation = resolveVoiceComposerPresentation(
    voiceInput.state,
    voiceInput.elapsedSeconds,
  );
  const dictating = voicePresentation.statusKind === "active";
  const locked = props.posting || voiceInput.blocksSubmission;
  const canSend = props.blocked === null && !locked && draft.trim().length > 0;

  const sending = useRef(false);
  const flushAndSubmit = async () => {
    await editorRef.current?.flushPendingInput();
    const submitted = latestDraft.current;
    if (submitted.trim().length === 0) return;
    const sent = await props.onSubmit(submitted, props.audiences ? audience : undefined);
    if (sent && latestDraft.current === submitted) changeDraft("");
  };
  const send = () => {
    if (!canSend || sending.current) return Promise.resolve();
    sending.current = true;
    // `finally` on the promise: the React Compiler does not compile a `try` without a `catch`.
    return flushAndSubmit().finally(() => {
      sending.current = false;
    });
  };
  const sendButton = (
    <ComposerActionButton
      size={chrome.controlSize}
      accessibilityLabel={props.posting ? gt("Posting comment") : gt("Post comment")}
      icon="arrow.up"
      variant="primary"
      disabled={!canSend}
      onPress={() => void send()}
    />
  );
  const editor = (
    <ComposerEditor
      ref={editorRef}
      multiline
      value={draft}
      readOnly={locked}
      selection={selection}
      onChangeText={(text) => {
        if (!locked) changeDraft(text);
      }}
      onSelectionChange={setSelection}
      placeholder={gt("Leave a comment")}
      onFocus={() => {
        setFocused(true);
        props.onFocusChange(true);
      }}
      onBlur={() => {
        setFocused(false);
        props.onFocusChange(false);
      }}
      onSubmit={() => void send()}
      submitTitle={gt("Comment", { $context: "verb, posts the comment" })}
      {...(props.audiences
        ? {
            singleLineCentered: false,
            contentInsetVertical: 0,
            scrollEnabled: Platform.OS === "android" || contentHeight >= bodyText.lineHeight * 4,
            onContentSizeChange: ({ height }: { height: number }) => setContentHeight(height),
            style: { height: twoLineEditorHeight },
          }
        : compactEditor.editorProps)}
      textStyle={textStyle}
    />
  );
  const audienceMenu = props.audiences ? (
    <Menu
      title={gt("Comment audience")}
      style={{ flexShrink: 1, minWidth: 0 }}
      actions={[
        {
          id: "internal",
          title: gt("Internal note"),
          state: audience === "internal" ? "on" : "off",
          attributes: { disabled: locked },
        },
        {
          id: "public",
          title: gt("Reply to customer"),
          state: audience === "public" ? "on" : "off",
          attributes: { disabled: locked },
        },
      ]}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === "internal" || nativeEvent.event === "public") {
          setAudience(nativeEvent.event);
        }
      }}
    >
      <View pointerEvents="none">
        <ComposerInlineControl
          size={chrome.controlSize}
          label={audience === "internal" ? gt("Internal note") : gt("Reply to customer")}
        />
      </View>
    </Menu>
  ) : null;
  const dictationStart = (
    <ComposerDictationStartAction
      size={chrome.controlSize}
      state={voiceInput.state}
      isAvailable={voiceInput.isAvailable}
      disabled={locked}
      onStart={voiceInput.start}
      onCancel={voiceInput.cancel}
    />
  );

  return (
    <Animated.View
      onLayout={(event) => props.onHeightChange(event.nativeEvent.layout.height)}
      className={Platform.OS === "android" ? "bg-screen px-[12px]" : "px-[12px]"}
      style={{ paddingTop: 6, paddingBottom: props.bottomInset + COMPOSER_BOTTOM_GUTTER }}
    >
      <View
        className={
          Platform.OS === "android"
            ? "hidden"
            : "absolute inset-0 bg-linear-to-b from-screen/0 via-screen/60 to-screen/90"
        }
        pointerEvents="none"
      />
      <View className="w-full self-center" style={{ maxWidth: props.contentMaxWidth }}>
        <ComposerSurface
          animateLayout={false}
          tone={props.audiences && audience === "internal" ? "warning" : undefined}
          style={{
            borderRadius: chrome.borderRadius,
            borderCurve: "circular",
            overflow: "hidden",
            paddingVertical: chrome.paddingVertical,
          }}
        >
          {props.blocked !== null ? (
            <View className="h-[44px] flex-row items-center">
              <Text
                className="min-w-0 flex-1 text-base text-foreground-muted"
                style={{ paddingLeft: EDITOR_LEADING_INSET }}
                numberOfLines={1}
                ellipsizeMode="tail"
              >
                {props.blocked}
              </Text>
              {sendButton}
            </View>
          ) : (
            <>
              <ComposerDictationError
                error={voiceInput.state.phase === "error" ? voiceInput.state.error : null}
                onDismiss={voiceInput.cancel}
              />
              {props.audiences ? (
                <ComposerDictationDraftContent compact hidden={dictating}>
                  <View className="px-3.5 pt-3 pb-1">{editor}</View>
                  {/* Send stays where the one-row composer and the dictation toolbar put it. */}
                  <View
                    className="flex-row items-center"
                    style={{ paddingLeft: EDITOR_LEADING_INSET - 8 }}
                  >
                    <View className="min-w-0 flex-1 items-start">{audienceMenu}</View>
                    {dictationStart}
                    {sendButton}
                  </View>
                </ComposerDictationDraftContent>
              ) : (
                <View onLayout={compactEditor.onRowLayout}>
                  <ComposerDictationDraftContent
                    className="flex-row items-end"
                    compact
                    hidden={dictating}
                  >
                    <View style={{ width: EDITOR_LEADING_INSET - 8 }} />
                    <Animated.View
                      className="min-w-0 flex-1"
                      onLayout={compactEditor.onEditorLayout}
                      style={[
                        { minWidth: compactEditor.isExpanded ? 0 : INLINE_EDITOR_MIN_WIDTH },
                        compactEditor.containerStyle,
                        compactEditor.isExpanded ? { flex: 0, width: 0 } : undefined,
                      ]}
                    />
                    {/* TalkBack orders siblings by position; outside this row the editor reads after Send. */}
                    <Animated.View
                      style={[
                        compactEditor.editorStyle,
                        // iOS destroys a view under display: none; the editor would lose its focus and caret.
                        Platform.OS === "android" && dictating ? { display: "none" } : undefined,
                      ]}
                    >
                      {editor}
                    </Animated.View>
                    <View
                      className="min-w-0 shrink flex-row items-center"
                      style={
                        compactEditor.isExpanded
                          ? { flex: 1, justifyContent: "flex-end" }
                          : undefined
                      }
                    >
                      {dictationStart}
                      {sendButton}
                    </View>
                  </ComposerDictationDraftContent>
                </View>
              )}
              <Animated.View
                accessibilityElementsHidden={!dictating}
                collapsable={false}
                importantForAccessibility={dictating ? "auto" : "no-hide-descendants"}
                pointerEvents={dictating ? "auto" : "none"}
                style={{ position: "absolute", bottom: chrome.paddingVertical, left: 0, right: 0 }}
              >
                <ComposerDictationToolbar showsDictation={dictating} visible={dictating}>
                  <ComposerToolbarRow
                    paddingBottom={0}
                    paddingHorizontal={0}
                    paddingTop={0}
                    style={{ gap: 0 }}
                  >
                    <ComposerDictationCancelAction
                      size={chrome.controlSize}
                      presentation={voicePresentation}
                      onCancel={voiceInput.cancel}
                    />
                    <ComposerDictationStatus
                      audioLevels={voiceInput.audioLevels}
                      elapsedSeconds={voiceInput.elapsedSeconds}
                      phase={voiceInput.state.phase}
                      presentation={voicePresentation}
                    />
                    <View className="shrink-0 flex-row items-center">
                      <ComposerDictationPrimaryAction
                        size={chrome.controlSize}
                        state={voiceInput.state}
                        presentation={voicePresentation}
                        isAvailable={voiceInput.isAvailable}
                        disabled={locked}
                        onStart={voiceInput.start}
                        onConfirm={voiceInput.stop}
                        onCancel={voiceInput.cancel}
                      />
                      {voicePresentation.showsSend ? sendButton : null}
                    </View>
                  </ComposerToolbarRow>
                </ComposerDictationToolbar>
              </Animated.View>
            </>
          )}
        </ComposerSurface>
      </View>
    </Animated.View>
  );
}
