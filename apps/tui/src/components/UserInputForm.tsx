import * as React from "react";

import { clip } from "../format.ts";
import { usePalette } from "../theme.ts";
import type { PendingUserInput } from "../userInput.ts";

// The pending user-input form (mirrors the web ComposerPendingUserInputPanel):
// renders the active question, its options with selection markers, and a progress
// hint. Purely presentational — key handling lives in useKeyBindings, the answer
// state in ChatView.

export const UserInputForm = React.memo(function UserInputForm({
  pending,
  questionIndex,
  optionIndex,
  selectedLabels,
  width,
}: {
  readonly pending: PendingUserInput;
  readonly questionIndex: number;
  readonly optionIndex: number;
  readonly selectedLabels: ReadonlyArray<string>;
  readonly width: number;
}): React.ReactNode {
  const palette = usePalette();
  const question = pending.questions[Math.min(questionIndex, pending.questions.length - 1)];
  if (!question) return null;
  const multi = question.multiSelect;
  const labelRoom = Math.max(8, width - 8);
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
        <span fg={palette.accent}>{`${question.header}  `}</span>
        {pending.questions.length > 1 ? (
          <span fg={palette.dim}>{`(${questionIndex + 1} of ${pending.questions.length})`}</span>
        ) : null}
      </text>
      <text fg={palette.text}>{clip(question.question, labelRoom)}</text>
      {question.options.map((option, index) => {
        const active = index === optionIndex;
        const selected = selectedLabels.includes(option.label);
        const marker = multi ? (selected ? "[x]" : "[ ]") : selected ? "(•)" : "( )";
        return (
          <text key={option.label}>
            <span fg={active ? palette.accent : palette.dim}>{active ? "▸ " : "  "}</span>
            <span fg={selected ? palette.accent : palette.dim}>{`${marker} `}</span>
            <span fg={active ? palette.text : palette.dim}>{clip(option.label, labelRoom)}</span>
          </text>
        );
      })}
      <text fg={palette.dim}>
        {multi
          ? "↑/↓ move · Space toggle · Enter confirm · Esc defer"
          : "↑/↓ select · Enter answer · Esc defer"}
      </text>
    </box>
  );
});
