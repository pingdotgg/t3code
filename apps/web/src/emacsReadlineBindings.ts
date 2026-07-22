export type EmacsReadlineAction =
  | "backward-char"
  | "backward-kill-word"
  | "backward-word"
  | "beginning-of-line"
  | "delete-backward"
  | "delete-forward"
  | "end-of-line"
  | "forward-char"
  | "forward-kill-word"
  | "forward-line"
  | "forward-word"
  | "kill-line"
  | "previous-line"
  | "transpose-chars"
  | "unix-line-discard"
  | "yank";

export interface PlainTextEdit {
  readonly inputType?: string;
  readonly killedText?: string;
  readonly selectionEnd: number;
  readonly selectionStart: number;
  readonly value: string;
}

const CANDIDATE_SURFACE_SELECTOR = [
  '[data-slot="command-dialog-popup"]',
  '[data-slot="command-list"]',
  '[data-slot="combobox-popup"]',
  '[data-slot="autocomplete-popup"]',
  '[data-slot="select-popup"]',
  '[data-slot="menu-popup"]',
  '[role="listbox"]',
].join(",");

function keyLetter(event: KeyboardEvent): string {
  if (event.code.startsWith("Key")) return event.code.slice(3).toLowerCase();
  return event.key.length === 1 ? event.key.toLowerCase() : "";
}

export function resolveEmacsReadlineAction(event: KeyboardEvent): EmacsReadlineAction | null {
  if (event.defaultPrevented || event.isComposing || event.metaKey || event.shiftKey) return null;

  const letter = keyLetter(event);
  if (event.ctrlKey && !event.altKey) {
    switch (letter) {
      case "a":
        return "beginning-of-line";
      case "b":
        return "backward-char";
      case "d":
        return "delete-forward";
      case "e":
        return "end-of-line";
      case "f":
        return "forward-char";
      case "h":
        return "delete-backward";
      case "k":
        return "kill-line";
      case "n":
        return "forward-line";
      case "p":
        return "previous-line";
      case "t":
        return "transpose-chars";
      case "u":
        return "unix-line-discard";
      case "w":
        return "backward-kill-word";
      case "y":
        return "yank";
      default:
        return null;
    }
  }

  if (event.altKey && !event.ctrlKey) {
    switch (letter) {
      case "b":
        return "backward-word";
      case "d":
        return "forward-kill-word";
      case "f":
        return "forward-word";
      default:
        return null;
    }
  }

  return null;
}

function lineStart(value: string, position: number): number {
  return value.lastIndexOf("\n", Math.max(0, position - 1)) + 1;
}

function lineEnd(value: string, position: number): number {
  const end = value.indexOf("\n", position);
  return end === -1 ? value.length : end;
}

function previousLinePosition(value: string, position: number): number {
  const currentStart = lineStart(value, position);
  if (currentStart === 0) return position;
  const column = position - currentStart;
  const previousEnd = currentStart - 1;
  const previousStart = lineStart(value, previousEnd);
  return Math.min(previousStart + column, previousEnd);
}

function nextLinePosition(value: string, position: number): number {
  const currentStart = lineStart(value, position);
  const currentEnd = lineEnd(value, position);
  if (currentEnd === value.length) return position;
  const column = position - currentStart;
  const nextStart = currentEnd + 1;
  return Math.min(nextStart + column, lineEnd(value, nextStart));
}

function isWordCharacter(character: string): boolean {
  return /[\p{L}\p{N}_]/u.test(character);
}

function backwardWordPosition(value: string, position: number): number {
  let next = position;
  while (next > 0 && !isWordCharacter(value[next - 1] ?? "")) next -= 1;
  while (next > 0 && isWordCharacter(value[next - 1] ?? "")) next -= 1;
  return next;
}

function forwardWordPosition(value: string, position: number): number {
  let next = position;
  while (next < value.length && !isWordCharacter(value[next] ?? "")) next += 1;
  while (next < value.length && isWordCharacter(value[next] ?? "")) next += 1;
  return next;
}

function backwardKillWordPosition(value: string, position: number): number {
  let next = position;
  while (next > 0 && /\s/u.test(value[next - 1] ?? "")) next -= 1;
  while (next > 0 && !/\s/u.test(value[next - 1] ?? "")) next -= 1;
  return next;
}

function movement(value: string, position: number): PlainTextEdit {
  return { value, selectionStart: position, selectionEnd: position };
}

function replacement(
  value: string,
  start: number,
  end: number,
  insertedText: string,
  inputType: string,
  killedText?: string,
): PlainTextEdit {
  const nextPosition = start + insertedText.length;
  return {
    value: value.slice(0, start) + insertedText + value.slice(end),
    selectionStart: nextPosition,
    selectionEnd: nextPosition,
    inputType,
    ...(killedText === undefined ? {} : { killedText }),
  };
}

export function applyEmacsReadlineActionToPlainText(input: {
  readonly action: EmacsReadlineAction;
  readonly selectionEnd: number;
  readonly selectionStart: number;
  readonly value: string;
  readonly yankText?: string;
}): PlainTextEdit {
  const { action, value } = input;
  const start = Math.min(input.selectionStart, input.selectionEnd);
  const end = Math.max(input.selectionStart, input.selectionEnd);

  switch (action) {
    case "beginning-of-line":
      return movement(value, lineStart(value, start));
    case "end-of-line":
      return movement(value, lineEnd(value, end));
    case "backward-char":
      return movement(value, start === end ? Math.max(0, start - 1) : start);
    case "forward-char":
      return movement(value, start === end ? Math.min(value.length, end + 1) : end);
    case "previous-line":
      return movement(value, previousLinePosition(value, start));
    case "forward-line":
      return movement(value, nextLinePosition(value, end));
    case "backward-word":
      return movement(value, backwardWordPosition(value, start));
    case "forward-word":
      return movement(value, forwardWordPosition(value, end));
    case "delete-backward": {
      const deleteStart = start === end ? Math.max(0, start - 1) : start;
      return replacement(value, deleteStart, end, "", "deleteContentBackward");
    }
    case "delete-forward": {
      const deleteEnd = start === end ? Math.min(value.length, end + 1) : end;
      return replacement(value, start, deleteEnd, "", "deleteContentForward");
    }
    case "kill-line": {
      const killEnd =
        start !== end
          ? end
          : lineEnd(value, start) === start && start < value.length
            ? start + 1
            : lineEnd(value, start);
      return replacement(
        value,
        start,
        killEnd,
        "",
        "deleteContentForward",
        value.slice(start, killEnd),
      );
    }
    case "unix-line-discard": {
      const killStart = start !== end ? start : lineStart(value, start);
      return replacement(
        value,
        killStart,
        end,
        "",
        "deleteContentBackward",
        value.slice(killStart, end),
      );
    }
    case "backward-kill-word": {
      const killStart = start !== end ? start : backwardKillWordPosition(value, start);
      return replacement(
        value,
        killStart,
        end,
        "",
        "deleteWordBackward",
        value.slice(killStart, end),
      );
    }
    case "forward-kill-word": {
      const killEnd = start !== end ? end : forwardWordPosition(value, end);
      return replacement(
        value,
        start,
        killEnd,
        "",
        "deleteWordForward",
        value.slice(start, killEnd),
      );
    }
    case "yank":
      return replacement(value, start, end, input.yankText ?? "", "insertText");
    case "transpose-chars": {
      if (start !== end || value.length < 2 || start === 0) return movement(value, end);
      const left = start === value.length ? start - 2 : start - 1;
      const right = left + 1;
      const transposed = value.slice(0, left) + value[right] + value[left] + value.slice(right + 1);
      const nextPosition = Math.min(value.length, start === value.length ? start : start + 1);
      return {
        value: transposed,
        selectionStart: nextPosition,
        selectionEnd: nextPosition,
        inputType: "insertTranspose",
      };
    }
  }
}

function isTerminalTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("[data-terminal-owner]") !== null;
}

function isCandidateSelectionOpen(document: Document): boolean {
  return Array.from(document.querySelectorAll<HTMLElement>(CANDIDATE_SURFACE_SELECTOR)).some(
    (element) => !element.hidden && element.getAttribute("aria-hidden") !== "true",
  );
}

function dispatchCandidateNavigation(event: KeyboardEvent, key: "ArrowDown" | "ArrowUp"): void {
  event.preventDefault();
  event.stopImmediatePropagation();
  const document = (event.target as Node | null)?.ownerDocument ?? globalThis.document;
  const target =
    document.activeElement instanceof HTMLElement ? document.activeElement : event.target;
  if (!(target instanceof EventTarget)) return;
  const KeyboardEventConstructor = document.defaultView?.KeyboardEvent ?? KeyboardEvent;
  target.dispatchEvent(
    new KeyboardEventConstructor("keydown", {
      bubbles: true,
      cancelable: true,
      code: key,
      key,
      repeat: event.repeat,
    }),
  );
}

type PlainTextControl = HTMLInputElement | HTMLTextAreaElement;

function getPlainTextControl(target: EventTarget | null): PlainTextControl | null {
  if (target instanceof HTMLTextAreaElement) return target;
  if (!(target instanceof HTMLInputElement)) return null;
  try {
    return target.selectionStart === null ? null : target;
  } catch {
    return null;
  }
}

function getContentEditableHost(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  return target.closest<HTMLElement>(
    '[contenteditable="true"], [contenteditable="plaintext-only"]',
  );
}

function dispatchInputEvent(control: PlainTextControl, inputType: string): void {
  const InputEventConstructor = control.ownerDocument.defaultView?.InputEvent ?? InputEvent;
  control.dispatchEvent(
    new InputEventConstructor("input", { bubbles: true, inputType, data: null }),
  );
}

function applyActionToPlainTextControl(
  control: PlainTextControl,
  action: EmacsReadlineAction,
  yankText: string,
): { readonly handled: boolean; readonly killedText?: string } {
  if (control.disabled || control.readOnly) return { handled: false };
  const selectionStart = control.selectionStart;
  const selectionEnd = control.selectionEnd;
  if (selectionStart === null || selectionEnd === null) return { handled: false };

  const edit = applyEmacsReadlineActionToPlainText({
    action,
    value: control.value,
    selectionStart,
    selectionEnd,
    yankText,
  });
  if (edit.inputType) {
    control.setRangeText(edit.value, 0, control.value.length, "end");
    control.setSelectionRange(edit.selectionStart, edit.selectionEnd);
    dispatchInputEvent(control, edit.inputType);
  } else {
    control.setSelectionRange(edit.selectionStart, edit.selectionEnd);
  }
  return {
    handled: true,
    ...(control.type === "password" || edit.killedText === undefined
      ? {}
      : { killedText: edit.killedText }),
  };
}

type SelectionWithModify = Selection & {
  modify(alter: "extend" | "move", direction: "backward" | "forward", granularity: string): void;
};

function selectionBelongsToHost(selection: Selection, host: HTMLElement): boolean {
  const anchor = selection.anchorNode;
  return anchor !== null && (anchor === host || host.contains(anchor));
}

function applyActionToContentEditable(
  host: HTMLElement,
  action: EmacsReadlineAction,
  yankText: string,
): { readonly handled: boolean; readonly killedText?: string } {
  const document = host.ownerDocument;
  const selection = document.getSelection() as SelectionWithModify | null;
  if (
    !selection ||
    !selectionBelongsToHost(selection, host) ||
    typeof selection.modify !== "function"
  ) {
    return { handled: false };
  }

  const move = (direction: "backward" | "forward", granularity: string) => {
    selection.modify("move", direction, granularity);
  };
  const extendAndDelete = (direction: "backward" | "forward", granularity: string) => {
    if (selection.isCollapsed) selection.modify("extend", direction, granularity);
    if (selection.isCollapsed && direction === "forward" && granularity === "lineboundary") {
      selection.modify("extend", "forward", "character");
    }
    const killedText = selection.toString();
    document.execCommand("delete");
    return killedText;
  };

  let killedText: string | undefined;
  switch (action) {
    case "beginning-of-line":
      move("backward", "lineboundary");
      break;
    case "end-of-line":
      move("forward", "lineboundary");
      break;
    case "backward-char":
      move("backward", "character");
      break;
    case "forward-char":
      move("forward", "character");
      break;
    case "previous-line":
      move("backward", "line");
      break;
    case "forward-line":
      move("forward", "line");
      break;
    case "backward-word":
      move("backward", "word");
      break;
    case "forward-word":
      move("forward", "word");
      break;
    case "delete-backward":
      if (selection.isCollapsed) selection.modify("extend", "backward", "character");
      document.execCommand("delete");
      break;
    case "delete-forward":
      if (selection.isCollapsed) selection.modify("extend", "forward", "character");
      document.execCommand("delete");
      break;
    case "kill-line":
      killedText = extendAndDelete("forward", "lineboundary");
      break;
    case "unix-line-discard":
      killedText = extendAndDelete("backward", "lineboundary");
      break;
    case "backward-kill-word":
      killedText = extendAndDelete("backward", "word");
      break;
    case "forward-kill-word":
      killedText = extendAndDelete("forward", "word");
      break;
    case "yank":
      document.execCommand("insertText", false, yankText);
      break;
    case "transpose-chars":
      // Native contenteditable does not expose a reliable atomic transpose
      // operation. Consume the browser shortcut here; plain inputs and
      // textareas implement the full readline behavior above.
      break;
  }

  return { handled: true, ...(killedText === undefined ? {} : { killedText }) };
}

export function createEmacsReadlineKeydownHandler(): (event: KeyboardEvent) => void {
  let killRingText = "";

  return (event) => {
    const action = resolveEmacsReadlineAction(event);
    if (!action || isTerminalTarget(event.target)) return;

    const document = (event.target as Node | null)?.ownerDocument ?? globalThis.document;
    if (
      (action === "forward-line" || action === "previous-line") &&
      isCandidateSelectionOpen(document)
    ) {
      dispatchCandidateNavigation(event, action === "forward-line" ? "ArrowDown" : "ArrowUp");
      return;
    }

    const control = getPlainTextControl(event.target);
    const editableHost = control ? null : getContentEditableHost(event.target);
    const result = control
      ? applyActionToPlainTextControl(control, action, killRingText)
      : editableHost
        ? applyActionToContentEditable(editableHost, action, killRingText)
        : { handled: false };

    if (!result.handled) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (result.killedText) killRingText = result.killedText;
  };
}
