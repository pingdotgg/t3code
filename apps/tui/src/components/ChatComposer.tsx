import {
  defaultTextareaKeyBindings,
  type PasteEvent,
  type TextareaRenderable,
} from "@opentui/core";
import { Image } from "@t3tools/opentui-image/react";
import * as React from "react";

import type { ComposerImageAttachment } from "../composerAttachments.ts";
import type { ComposerControls } from "../controls.ts";
import { clip } from "../format.ts";
import { usePalette } from "../theme.ts";
import type { PendingUserInput } from "../userInput.ts";
import { ComposerFooter } from "./ComposerFooter.tsx";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel.tsx";

// Reply key map. The textarea ALWAYS merges these over its defaults, so we can't
// remove a default by omission — we override it. Two concerns:
//   1. Enter sends (like the web composer); Shift+Enter / Ctrl+J insert a newline.
//   2. The editor's default ^K (delete-to-line-end) and ^U (delete-to-line-start)
//      collide with the app's global ^K (actions) and ^U (user-input), which fire
//      alongside the focused editor — left as-is, pressing them would also shred
//      the draft. Override them to harmless cursor moves so the keys belong to the
//      app, not the editor. (^A/^E/^B/^F also overlap but only move the cursor.)
const replyKeyBindings: typeof defaultTextareaKeyBindings = [
  ...defaultTextareaKeyBindings.filter(
    (binding) =>
      binding.name !== "return" && binding.name !== "kpenter" && binding.name !== "linefeed",
  ),
  { name: "k", ctrl: true, action: "line-end" },
  { name: "u", ctrl: true, action: "line-home" },
  { name: "return", shift: true, action: "newline" },
  { name: "kpenter", shift: true, action: "newline" },
  { name: "linefeed", action: "newline" },
  { name: "return", action: "submit" },
  { name: "kpenter", action: "submit" },
];

// The prompt composer (mirrors apps/web/src/components/chat/ChatComposer.tsx).
// New threads use this same always-ready prompt; ChatView swaps the local draft
// and submit action without introducing a second form or keyboard mode.
//
// When `inputFocused` is false (the terminal pane holds focus) we render the
// field as STATIC text instead of an <input> — OpenTUI doesn't reliably blur an
// input when nothing else takes focus, so a mounted input would keep consuming
// keystrokes that are meant for the terminal. Not mounting it guarantees a single
// consumer.

function ComposerImageAttachments({
  attachments,
  inlineImagesSupported,
  width,
  onRemove,
}: {
  readonly attachments: ReadonlyArray<ComposerImageAttachment>;
  readonly inlineImagesSupported: boolean;
  readonly width: number;
  readonly onRemove: (relativePath: string) => void;
}): React.ReactNode {
  const palette = usePalette();
  if (attachments.length === 0) return null;
  const itemWidth = 14;
  const visibleCount = Math.max(1, Math.min(4, Math.floor(width / (itemWidth + 1))));
  const visible = attachments.slice(0, visibleCount);
  const hiddenCount = attachments.length - visible.length;

  return (
    <box flexDirection="row" flexShrink={0}>
      {visible.map((attachment) => (
        <box
          key={attachment.relativePath}
          flexDirection="column"
          width={itemWidth}
          marginRight={1}
          onMouseDown={() => onRemove(attachment.relativePath)}
        >
          <text>
            <span fg={palette.accent}>× </span>
            <span fg={palette.text}>{clip(attachment.upload.name, itemWidth - 2)}</span>
          </text>
          {inlineImagesSupported ? (
            <Image
              data={attachment.preview.data}
              imageWidth={attachment.preview.imageWidth}
              imageHeight={attachment.preview.imageHeight}
              columns={8}
              rows={3}
            />
          ) : null}
        </box>
      ))}
      {hiddenCount > 0 ? <text fg={palette.dim}>{`+${hiddenCount} more`}</text> : null}
    </box>
  );
}

export const ChatComposer = React.memo(function ChatComposer({
  mode,
  reply,
  auxValue,
  placeholder,
  editorRows,
  inputFocused,
  composerEpoch,
  controls,
  working,
  attachments,
  inlineImagesSupported,
  width,
  pendingUserInput,
  uiQuestionIndex,
  uiOptionIndex,
  uiSelectedLabels,
  answerDraft,
  onAnswerInput,
  onReplyInput,
  onReplySubmit,
  onAuxInput,
  onTogglePlan,
  onOpenAccess,
  onOpenModel,
  onOpenReasoning,
  onStop,
  onSend,
  onSubmitAnswer,
  onRemoveAttachment,
  onPasteImage,
}: {
  readonly mode: "compose" | "rename" | "filter" | "commit";
  readonly reply: string;
  /** Value for the single-line rename/filter inputs. */
  readonly auxValue: string;
  readonly placeholder: string;
  /** Fixed height (rows) of the reply editor; content beyond it scrolls. */
  readonly editorRows: number;
  /** False when the terminal pane holds focus — render static text, not an input. */
  readonly inputFocused: boolean;
  /** Bumped by the parent to remount (clear) the reply editor after send/clear. */
  readonly composerEpoch: number;
  /** Composer controls shown inside the box (compose mode only), mirroring web. */
  readonly controls: ComposerControls;
  readonly working: boolean;
  readonly attachments: ReadonlyArray<ComposerImageAttachment>;
  readonly inlineImagesSupported: boolean;
  /** Content width for the pending-question panel's wrapping. */
  readonly width: number;
  /** When set, a question panel renders above the input and Enter submits the answer. */
  readonly pendingUserInput: PendingUserInput | null;
  readonly uiQuestionIndex: number;
  readonly uiOptionIndex: number;
  readonly uiSelectedLabels: ReadonlyArray<string>;
  /** The free-text custom answer typed while a question is pending. */
  readonly answerDraft: string;
  readonly onAnswerInput: (value: string) => void;
  readonly onReplyInput: (value: string) => void;
  readonly onReplySubmit: () => void;
  readonly onAuxInput: (value: string) => void;
  readonly onTogglePlan: () => void;
  readonly onOpenAccess: () => void;
  readonly onOpenModel: () => void;
  readonly onOpenReasoning: () => void;
  readonly onStop: () => void;
  readonly onSend: () => void;
  readonly onSubmitAnswer: () => void;
  readonly onRemoveAttachment: (relativePath: string) => void;
  readonly onPasteImage: (paste: { readonly bytes: Uint8Array; readonly mimeType: string }) => void;
}): React.ReactNode {
  const palette = usePalette();
  const replyRef = React.useRef<TextareaRenderable | null>(null);
  // On (re)mount with a seeded draft — restored after an overlay or pulled back
  // from $EDITOR — drop the cursor at the end so typing continues from there.
  React.useEffect(() => {
    if (reply.length > 0) replyRef.current?.gotoBufferEnd();
    // Mount/epoch only; not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composerEpoch]);

  if (mode === "rename" || mode === "filter" || mode === "commit") {
    const label = mode === "rename" ? "rename ▸ " : mode === "commit" ? "commit ▸ " : "find ▸ ";
    const hint =
      mode === "rename"
        ? "Enter rename · Esc cancel"
        : mode === "commit"
          ? "Enter commit · Esc cancel"
          : "Enter keep · Esc clear";
    const inputPlaceholder =
      mode === "rename"
        ? "New thread title…"
        : mode === "commit"
          ? "Commit message…"
          : "Filter by title…";
    return (
      <box
        flexDirection="column"
        width={width}
        border
        borderStyle="rounded"
        borderColor={palette.accent}
        paddingLeft={1}
        paddingRight={1}
        flexShrink={0}
      >
        <box flexDirection="row">
          <text>
            <span fg={palette.accent}>{label}</span>
          </text>
          <input
            value={auxValue}
            onInput={onAuxInput}
            focused={inputFocused}
            placeholder={inputPlaceholder}
            flexGrow={1}
            textColor={palette.text}
            cursorColor={palette.accent}
            placeholderColor={palette.dim}
          />
        </box>
        <text fg={palette.dim}>{hint}</text>
      </box>
    );
  }

  // While a question is pending the composer stays put (mirroring the web): the
  // question panel renders above a single-line custom-answer field, and the
  // footer's primary action becomes Submit answer. A single-line <input> (not the
  // multiline editor) leaves ↑/↓ + Enter to the question keymap (option nav +
  // submit) while typing fills a free-text answer.
  const answering = pendingUserInput !== null;
  // A free-text answer only makes sense for single-select questions (multi-select
  // toggles options); for those, Space must type rather than toggle (see the
  // `answerTyping` flag in ChatView/useKeyBindings).
  const allowCustomAnswer = answering && !pendingUserInput.questions[uiQuestionIndex]?.multiSelect;
  const showReplyEditor = inputFocused && !answering;
  const showAnswerInput = inputFocused && allowCustomAnswer;
  return (
    <box
      flexDirection="column"
      width={width}
      border
      borderStyle="rounded"
      borderColor={palette.dim}
      paddingLeft={1}
      paddingRight={1}
      flexShrink={0}
    >
      {pendingUserInput ? (
        <ComposerPendingUserInputPanel
          pending={pendingUserInput}
          questionIndex={uiQuestionIndex}
          optionIndex={uiOptionIndex}
          selectedLabels={uiSelectedLabels}
          width={width}
        />
      ) : null}
      <ComposerImageAttachments
        attachments={attachments}
        inlineImagesSupported={inlineImagesSupported}
        width={width}
        onRemove={onRemoveAttachment}
      />
      <box flexDirection="row" flexShrink={0}>
        {showReplyEditor ? (
          // Multiline editor: Enter sends, Shift+Enter newlines, paste inserts the
          // full clipboard (no single-line cap). Uncontrolled — remounted via
          // `composerEpoch` to clear after send; content mirrored out via onContentChange.
          <textarea
            key={`reply-${composerEpoch}`}
            ref={replyRef}
            focused
            // Seeds on (re)mount only — restores the draft when the composer remounts
            // after an overlay/terminal-focus, without fighting live edits.
            initialValue={reply}
            placeholder={placeholder}
            flexGrow={1}
            // Fixed viewport so long prompts scroll (cursor stays in view) instead of
            // overflowing; ^↑/^↓ change this height.
            height={Math.max(1, editorRows)}
            wrapMode="word"
            keyBindings={replyKeyBindings}
            textColor={palette.text}
            cursorColor={palette.accent}
            placeholderColor={palette.dim}
            onContentChange={() => onReplyInput(replyRef.current?.plainText ?? "")}
            onSubmit={onReplySubmit}
            onPaste={(event: PasteEvent) => {
              const mimeType = event.metadata?.mimeType;
              if (!mimeType?.toLowerCase().startsWith("image/")) return;
              event.preventDefault();
              event.stopPropagation();
              onPasteImage({ bytes: event.bytes, mimeType });
            }}
          />
        ) : showAnswerInput ? (
          <input
            value={answerDraft}
            onInput={onAnswerInput}
            focused
            placeholder="Type your own answer, or leave blank to use the selected option"
            flexGrow={1}
            textColor={palette.text}
            cursorColor={palette.accent}
            placeholderColor={palette.dim}
          />
        ) : (
          <text>
            {answering ? (
              <span fg={palette.dim}>pick an option above, then Enter to submit</span>
            ) : reply.length > 0 ? (
              <>
                <span fg={palette.accent}>{"^P prompt · "}</span>
                <span fg={palette.text}>{reply}</span>
              </>
            ) : (
              <>
                <span fg={palette.accent}>{"^P prompt · "}</span>
                <span fg={palette.dim}>{placeholder}</span>
              </>
            )}
          </text>
        )}
      </box>
      <ComposerFooter
        controls={controls}
        compact={width < 64}
        width={Math.max(1, width - 2)}
        working={working}
        answering={answering}
        hasText={reply.length > 0 || attachments.length > 0}
        onTogglePlan={onTogglePlan}
        onOpenAccess={onOpenAccess}
        onOpenModel={onOpenModel}
        onOpenReasoning={onOpenReasoning}
        onStop={onStop}
        onSend={onSend}
        onSubmitAnswer={onSubmitAnswer}
      />
    </box>
  );
});
