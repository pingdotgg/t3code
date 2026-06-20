import { defaultTextareaKeyBindings, type TextareaRenderable } from "@opentui/core";
import * as React from "react";

import { usePalette } from "../theme.ts";

// Reply key map: Enter sends (like the web composer), Shift+Enter inserts a
// newline. linefeed (Ctrl+J) is a reliable newline fallback for terminals that
// can't report Shift+Enter. All other editing/navigation bindings (arrows,
// word-jumps, undo, paste) are inherited from the textarea defaults.
const replyKeyBindings: typeof defaultTextareaKeyBindings = [
  ...defaultTextareaKeyBindings.filter(
    (binding) =>
      binding.name !== "return" && binding.name !== "kpenter" && binding.name !== "linefeed",
  ),
  { name: "return", shift: true, action: "newline" },
  { name: "kpenter", shift: true, action: "newline" },
  { name: "linefeed", action: "newline" },
  { name: "return", action: "submit" },
  { name: "kpenter", action: "submit" },
];

// The prompt composer (mirrors apps/web/src/components/chat/ChatComposer.tsx). Two
// modes: the always-ready reply field, and the new-thread dialog (project chosen
// with ↑/↓ in ChatView, message typed here). Purely presentational.
//
// When `inputFocused` is false (the terminal pane holds focus) we render the
// field as STATIC text instead of an <input> — OpenTUI doesn't reliably blur an
// input when nothing else takes focus, so a mounted input would keep consuming
// keystrokes that are meant for the terminal. Not mounting it guarantees a single
// consumer.

export const ChatComposer = React.memo(function ChatComposer({
  mode,
  reply,
  draft,
  auxValue,
  placeholder,
  projectName,
  inputFocused,
  composerEpoch,
  onReplyInput,
  onReplySubmit,
  onDraftInput,
  onAuxInput,
}: {
  readonly mode: "compose" | "new" | "rename" | "filter";
  readonly reply: string;
  readonly draft: string;
  /** Value for the single-line rename/filter inputs. */
  readonly auxValue: string;
  readonly placeholder: string;
  readonly projectName: string;
  /** False when the terminal pane holds focus — render static text, not an input. */
  readonly inputFocused: boolean;
  /** Bumped by the parent to remount (clear) the reply editor after send/clear. */
  readonly composerEpoch: number;
  readonly onReplyInput: (value: string) => void;
  readonly onReplySubmit: () => void;
  readonly onDraftInput: (value: string) => void;
  readonly onAuxInput: (value: string) => void;
}): React.ReactNode {
  const palette = usePalette();
  const replyRef = React.useRef<TextareaRenderable | null>(null);

  if (mode === "rename" || mode === "filter") {
    const label = mode === "rename" ? "rename ▸ " : "find ▸ ";
    const hint = mode === "rename" ? "Enter rename · Esc cancel" : "Enter keep · Esc clear";
    const inputPlaceholder = mode === "rename" ? "New thread title…" : "Filter by title…";
    return (
      <box
        flexDirection="column"
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

  if (mode === "new") {
    return (
      <box
        flexDirection="column"
        border
        borderStyle="rounded"
        borderColor={palette.accent}
        paddingLeft={1}
        paddingRight={1}
        flexShrink={0}
      >
        <text>
          <span fg={palette.accent}>new thread ▸ project: </span>
          <span fg={palette.text}>{projectName}</span>
          <span fg={palette.dim}>{"  ↑/↓ change · Esc cancel"}</span>
        </text>
        <box flexDirection="row">
          <text>
            <span fg={palette.accent}>message ▸ </span>
          </text>
          <input
            value={draft}
            onInput={onDraftInput}
            focused={inputFocused}
            placeholder="Describe the task…"
            flexGrow={1}
            textColor={palette.text}
            cursorColor={palette.accent}
            placeholderColor={palette.dim}
          />
        </box>
      </box>
    );
  }

  return (
    <box
      flexDirection="row"
      border
      borderStyle="rounded"
      borderColor={inputFocused ? palette.accent : palette.dim}
      paddingLeft={1}
      paddingRight={1}
      flexShrink={0}
    >
      <text>
        <span fg={palette.accent}>{"› "}</span>
      </text>
      {inputFocused ? (
        // Multiline editor: Enter sends, Shift+Enter newlines, paste inserts the
        // full clipboard (no single-line cap). Uncontrolled — remounted via
        // `composerEpoch` to clear after send; content mirrored out via onContentChange.
        <textarea
          key={`reply-${composerEpoch}`}
          ref={replyRef}
          focused
          placeholder={placeholder}
          flexGrow={1}
          wrapMode="word"
          keyBindings={replyKeyBindings}
          textColor={palette.text}
          cursorColor={palette.accent}
          placeholderColor={palette.dim}
          onContentChange={() => onReplyInput(replyRef.current?.plainText ?? "")}
          onSubmit={onReplySubmit}
        />
      ) : (
        <text>
          {reply.length > 0 ? (
            <span fg={palette.text}>{reply}</span>
          ) : (
            <span fg={palette.dim}>^P to type a reply</span>
          )}
        </text>
      )}
    </box>
  );
});
