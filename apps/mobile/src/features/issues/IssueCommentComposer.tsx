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
import { ComposerActionButton, ComposerToolbarRow } from "../../components/ComposerToolbar";
import { AppText as Text } from "../../components/ui/AppText";
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
 * with the draft, dictation, and a round send button. `blocked` replaces the editor with the reason.
 */
export function IssueCommentComposer(props: {
  /** Names this draft to dictation, so a recording started here lands here. */
  readonly ownerKey: string;
  readonly label: string;
  readonly blocked: string | null;
  readonly posting: boolean;
  readonly bottomInset: number;
  readonly contentMaxWidth?: number;
  /** Resolves true once the comment is posted, which clears the draft. */
  readonly onSubmit: (body: string) => Promise<boolean>;
  readonly onHeightChange: (height: number) => void;
  readonly onFocusChange: (focused: boolean) => void;
}) {
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
  const compactEditor = useCompactComposerEditor(bodyText, draft, false);
  const voiceInput = useVoiceInputController({
    ownerKey: props.ownerKey,
    label: props.label,
    readDraftMessage: () => latestDraft.current,
    selection,
    disabled: props.blocked !== null,
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

  const send = async () => {
    if (!canSend) return;
    await editorRef.current?.flushPendingInput();
    const submitted = latestDraft.current;
    if (submitted.trim().length === 0) return;
    if ((await props.onSubmit(submitted)) && latestDraft.current === submitted) changeDraft("");
  };
  const sendButton = (
    <ComposerActionButton
      size={chrome.controlSize}
      accessibilityLabel={props.posting ? "Posting comment" : "Post comment"}
      icon="arrow.up"
      variant="primary"
      disabled={!canSend}
      onPress={() => void send()}
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
          style={{
            borderRadius: chrome.borderRadius,
            borderCurve: "circular",
            overflow: "hidden",
            paddingVertical: chrome.paddingVertical,
          }}
        >
          <ComposerDictationError
            error={voiceInput.state.phase === "error" ? voiceInput.state.error : null}
            onDismiss={voiceInput.cancel}
          />
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
                    style={[compactEditor.editorStyle, dictating ? { display: "none" } : undefined]}
                  >
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
                      placeholder="Leave a comment"
                      onFocus={() => props.onFocusChange(true)}
                      onBlur={() => props.onFocusChange(false)}
                      onSubmit={() => void send()}
                      submitTitle="Comment"
                      {...compactEditor.editorProps}
                      textStyle={textStyle}
                    />
                  </Animated.View>
                  <View
                    className="min-w-0 shrink flex-row items-center"
                    style={
                      compactEditor.isExpanded ? { flex: 1, justifyContent: "flex-end" } : undefined
                    }
                  >
                    <ComposerDictationStartAction
                      size={chrome.controlSize}
                      state={voiceInput.state}
                      isAvailable={voiceInput.isAvailable}
                      disabled={locked}
                      onStart={voiceInput.start}
                      onCancel={voiceInput.cancel}
                    />
                    {sendButton}
                  </View>
                </ComposerDictationDraftContent>
              </View>
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
