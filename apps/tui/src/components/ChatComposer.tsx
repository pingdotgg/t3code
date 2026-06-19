import * as React from "react";

import { usePalette } from "../theme.ts";

// The prompt composer (mirrors apps/web/src/components/chat/ChatComposer.tsx). Two
// modes: the always-ready reply field, and the new-thread dialog (project chosen
// with ↑/↓ in ChatView, message typed here). Purely presentational — value/onInput
// and the active project are owned by ChatView.

export const ChatComposer = React.memo(function ChatComposer({
  mode,
  reply,
  draft,
  placeholder,
  projectName,
  onReplyInput,
  onDraftInput,
}: {
  readonly mode: "compose" | "new";
  readonly reply: string;
  readonly draft: string;
  readonly placeholder: string;
  readonly projectName: string;
  readonly onReplyInput: (value: string) => void;
  readonly onDraftInput: (value: string) => void;
}): React.ReactNode {
  const palette = usePalette();

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
            focused
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
      borderColor={palette.accent}
      paddingLeft={1}
      paddingRight={1}
      flexShrink={0}
    >
      <text>
        <span fg={palette.accent}>{"› "}</span>
      </text>
      <input
        value={reply}
        onInput={onReplyInput}
        focused
        placeholder={placeholder}
        flexGrow={1}
        textColor={palette.text}
        cursorColor={palette.accent}
        placeholderColor={palette.dim}
      />
    </box>
  );
});
