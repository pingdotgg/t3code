import { useId, useState, type KeyboardEvent } from "react";

import { Button } from "../ui/button";

export function ThemeCssEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const hintId = useId();
  const [position, setPosition] = useState({ line: 1, column: 1 });
  const [tabIndents, setTabIndents] = useState(true);

  function updatePosition(editor: HTMLTextAreaElement) {
    const preceding = editor.value.slice(0, editor.selectionStart).split("\n");
    setPosition({ line: preceding.length, column: (preceding.at(-1)?.length ?? 0) + 1 });
  }

  function replaceSelection(editor: HTMLTextAreaElement, replacement: string) {
    // Native insertion preserves undo history for indentation as well as typing.
    if (!document.execCommand("insertText", false, replacement)) {
      editor.setRangeText(replacement, editor.selectionStart, editor.selectionEnd, "end");
    }
    onChange(editor.value);
    updatePosition(editor);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    const editor = event.currentTarget;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setTabIndents(false);
      return;
    }
    if (event.key === "Tab" && tabIndents) {
      event.preventDefault();
      const start = editor.selectionStart;
      const end = editor.selectionEnd;
      const lineStart = start === 0 ? 0 : editor.value.lastIndexOf("\n", start - 1) + 1;
      if (start === end && !event.shiftKey) {
        replaceSelection(editor, "  ");
      } else if (start === end) {
        const indent = editor.value.slice(lineStart).match(/^(?: {1,2}|\t)/)?.[0] ?? "";
        if (!indent) return;
        editor.setSelectionRange(lineStart, lineStart + indent.length);
        replaceSelection(editor, "");
        editor.setSelectionRange(
          Math.max(lineStart, start - indent.length),
          Math.max(lineStart, end - indent.length),
        );
      } else {
        // A selection ending at a line's start leaves that next line untouched.
        const blockEnd = end > start && editor.value[end - 1] === "\n" ? end - 1 : end;
        const selected = editor.value.slice(lineStart, blockEnd);
        const replacement = selected
          .split("\n")
          .map((line) => (event.shiftKey ? line.replace(/^(?: {1,2}|\t)/, "") : `  ${line}`))
          .join("\n");
        editor.setSelectionRange(lineStart, blockEnd);
        replaceSelection(editor, replacement);
        editor.setSelectionRange(lineStart, lineStart + replacement.length);
      }
      updatePosition(editor);
    } else if (event.key === "Enter" && editor.selectionStart === editor.selectionEnd) {
      const precedingLine = editor.value.slice(0, editor.selectionStart).split("\n").at(-1) ?? "";
      const indent = precedingLine.match(/^[\t ]*/)?.[0] ?? "";
      event.preventDefault();
      replaceSelection(editor, `\n${indent}${precedingLine.trimEnd().endsWith("{") ? "  " : ""}`);
    }
  }

  return (
    <div className="space-y-2">
      <div className="overflow-hidden rounded-lg border border-input bg-code text-code-foreground focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/24">
        <textarea
          aria-label="Custom CSS"
          aria-describedby={hintId}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          wrap="off"
          className="block h-52 min-h-32 w-full resize-y bg-transparent p-3 font-mono text-xs leading-5 outline-none"
          value={value}
          onFocus={() => setTabIndents(true)}
          onChange={(event) => {
            onChange(event.currentTarget.value);
            updatePosition(event.currentTarget);
          }}
          onSelect={(event) => updatePosition(event.currentTarget)}
          onKeyDown={handleKeyDown}
        />
        <div className="flex items-center justify-between border-t border-input px-3 py-1 font-mono text-xs">
          <span>CSS</span>
          <span>
            Ln {position.line}, Col {position.column}
          </span>
        </div>
      </div>
      <div className="flex items-start justify-between gap-2">
        <p id={hintId} className="text-xs text-muted-foreground">
          {tabIndents
            ? "Tab indents. Shift+Tab unindents. Press Escape, then Tab to leave."
            : "Tab moves to the next control."}
        </p>
        <Button
          size="xs"
          variant="ghost"
          disabled={!value}
          onClick={() => {
            onChange("");
            setPosition({ line: 1, column: 1 });
          }}
        >
          Clear CSS
        </Button>
      </div>
    </div>
  );
}
