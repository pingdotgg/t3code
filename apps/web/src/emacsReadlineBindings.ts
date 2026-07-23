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
  readonly insertedText?: string;
  readonly killedText?: string;
  readonly replacementEnd?: number;
  readonly replacementStart?: number;
  readonly selectionEnd: number;
  readonly selectionStart: number;
  readonly value: string;
}

const MUTATING_ACTIONS: ReadonlySet<EmacsReadlineAction> = new Set([
  "backward-kill-word",
  "delete-backward",
  "delete-forward",
  "forward-kill-word",
  "kill-line",
  "transpose-chars",
  "unix-line-discard",
  "yank",
]);

const CANDIDATE_SURFACE_SELECTOR = [
  "[data-composer-command-menu]",
  '[data-slot="command-dialog-popup"]',
  '[data-slot="command-list"]',
  '[data-slot="combobox-popup"]',
  '[data-slot="autocomplete-popup"]',
  '[data-slot="select-popup"]',
  '[data-slot="menu-popup"]',
  '[role="listbox"]',
].join(",");

function keyLetter(event: KeyboardEvent): string {
  if (/^[a-z]$/iu.test(event.key)) return event.key.toLowerCase();
  if (event.altKey) return event.code.match(/^Key([A-Z])$/)?.[1]?.toLowerCase() ?? "";
  return "";
}

function resolveUnclaimedEmacsReadlineAction(event: KeyboardEvent): EmacsReadlineAction | null {
  if (event.isComposing || event.metaKey || event.shiftKey) return null;

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

export function resolveEmacsReadlineAction(event: KeyboardEvent): EmacsReadlineAction | null {
  return event.defaultPrevented ? null : resolveUnclaimedEmacsReadlineAction(event);
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
  const column = codePointColumn(value, currentStart, position);
  const previousEnd = currentStart - 1;
  const previousStart = lineStart(value, previousEnd);
  return positionAtCodePointColumn(value, previousStart, previousEnd, column);
}

function nextLinePosition(value: string, position: number): number {
  const currentStart = lineStart(value, position);
  const currentEnd = lineEnd(value, position);
  if (currentEnd === value.length) return position;
  const column = codePointColumn(value, currentStart, position);
  const nextStart = currentEnd + 1;
  return positionAtCodePointColumn(value, nextStart, lineEnd(value, nextStart), column);
}

function isWordCharacter(character: string): boolean {
  return /[\p{L}\p{N}_]/u.test(character);
}

function previousCodePointPosition(value: string, position: number): number {
  if (position <= 0) return 0;
  const previous = position - 1;
  const previousUnit = value.charCodeAt(previous);
  if (previousUnit >= 0xdc00 && previousUnit <= 0xdfff && previous > 0) {
    const leadingUnit = value.charCodeAt(previous - 1);
    if (leadingUnit >= 0xd800 && leadingUnit <= 0xdbff) return previous - 1;
  }
  return previous;
}

function nextCodePointPosition(value: string, position: number): number {
  if (position >= value.length) return value.length;
  const currentUnit = value.charCodeAt(position);
  if (currentUnit >= 0xd800 && currentUnit <= 0xdbff && position + 1 < value.length) {
    const trailingUnit = value.charCodeAt(position + 1);
    if (trailingUnit >= 0xdc00 && trailingUnit <= 0xdfff) return position + 2;
  }
  return position + 1;
}

function codePointColumn(value: string, start: number, position: number): number {
  let cursor = start;
  let column = 0;
  while (cursor < position) {
    cursor = nextCodePointPosition(value, cursor);
    column += 1;
  }
  return column;
}

function positionAtCodePointColumn(
  value: string,
  start: number,
  end: number,
  column: number,
): number {
  let cursor = start;
  for (let currentColumn = 0; currentColumn < column && cursor < end; currentColumn += 1) {
    cursor = Math.min(nextCodePointPosition(value, cursor), end);
  }
  return cursor;
}

function codePointBefore(value: string, position: number): string {
  const previous = previousCodePointPosition(value, position);
  return value.slice(previous, position);
}

function codePointAt(value: string, position: number): string {
  return value.slice(position, nextCodePointPosition(value, position));
}

function backwardWordPosition(value: string, position: number): number {
  let next = position;
  while (next > 0 && !isWordCharacter(codePointBefore(value, next))) {
    next = previousCodePointPosition(value, next);
  }
  while (next > 0 && isWordCharacter(codePointBefore(value, next))) {
    next = previousCodePointPosition(value, next);
  }
  return next;
}

function forwardWordPosition(value: string, position: number): number {
  let next = position;
  while (next < value.length && !isWordCharacter(codePointAt(value, next))) {
    next = nextCodePointPosition(value, next);
  }
  while (next < value.length && isWordCharacter(codePointAt(value, next))) {
    next = nextCodePointPosition(value, next);
  }
  return next;
}

function backwardKillWordPosition(value: string, position: number): number {
  let next = position;
  while (next > 0 && /\s/u.test(codePointBefore(value, next))) {
    next = previousCodePointPosition(value, next);
  }
  while (next > 0 && !/\s/u.test(codePointBefore(value, next))) {
    next = previousCodePointPosition(value, next);
  }
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
    insertedText,
    replacementStart: start,
    replacementEnd: end,
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
      return movement(value, start === end ? previousCodePointPosition(value, start) : start);
    case "forward-char":
      return movement(value, start === end ? nextCodePointPosition(value, end) : end);
    case "previous-line":
      return movement(value, previousLinePosition(value, start));
    case "forward-line":
      return movement(value, nextLinePosition(value, end));
    case "backward-word":
      return movement(value, backwardWordPosition(value, start));
    case "forward-word":
      return movement(value, forwardWordPosition(value, end));
    case "delete-backward": {
      const deleteStart = start === end ? previousCodePointPosition(value, start) : start;
      return replacement(value, deleteStart, end, "", "deleteContentBackward");
    }
    case "delete-forward": {
      const deleteEnd = start === end ? nextCodePointPosition(value, end) : end;
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
      if (!input.yankText) {
        return {
          value,
          selectionStart: input.selectionStart,
          selectionEnd: input.selectionEnd,
        };
      }
      return replacement(value, start, end, input.yankText ?? "", "insertText");
    case "transpose-chars": {
      if (start !== end || start === 0) {
        return {
          value,
          selectionStart: input.selectionStart,
          selectionEnd: input.selectionEnd,
        };
      }
      const rightStart = start === value.length ? previousCodePointPosition(value, start) : start;
      const leftStart = previousCodePointPosition(value, rightStart);
      if (leftStart === rightStart || rightStart >= value.length) {
        return {
          value,
          selectionStart: input.selectionStart,
          selectionEnd: input.selectionEnd,
        };
      }
      const rightEnd = nextCodePointPosition(value, rightStart);
      const leftCharacter = value.slice(leftStart, rightStart);
      const rightCharacter = value.slice(rightStart, rightEnd);
      const transposed =
        value.slice(0, leftStart) + rightCharacter + leftCharacter + value.slice(rightEnd);
      const nextPosition = start === value.length ? start : rightEnd;
      return {
        value: transposed,
        selectionStart: nextPosition,
        selectionEnd: nextPosition,
        inputType: "insertTranspose",
        insertedText: `${rightCharacter}${leftCharacter}`,
        replacementStart: leftStart,
        replacementEnd: rightEnd,
      };
    }
  }
}

function isTerminalTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("[data-terminal-owner]") !== null;
}

function candidateSurfaceBelongsToFocus(
  surface: HTMLElement,
  focusedElement: Element | null,
  document: Document,
): boolean {
  if (!focusedElement) return false;
  if (surface.contains(focusedElement)) return true;

  const controlledIds = focusedElement.getAttribute("aria-controls")?.split(/\s+/) ?? [];
  if (surface.id && controlledIds.includes(surface.id)) return true;

  // Composer suggestions keep focus in the editor while rendering their list
  // immediately above it. Accept a nearby shared container, but never climb
  // as far as body where an unrelated open picker would also appear related.
  let container = surface.parentElement;
  for (let depth = 0; container && depth < 6; depth += 1) {
    if (container === document.body) return false;
    if (container.contains(focusedElement)) return true;
    container = container.parentElement;
  }
  return false;
}

function isCandidateSelectionOpen(document: Document, eventTarget: EventTarget | null): boolean {
  const focusedElement =
    document.activeElement instanceof Element
      ? document.activeElement
      : eventTarget instanceof Element
        ? eventTarget
        : null;
  return Array.from(document.querySelectorAll<HTMLElement>(CANDIDATE_SURFACE_SELECTOR)).some(
    (element) =>
      !element.hidden &&
      element.getAttribute("aria-hidden") !== "true" &&
      candidateSurfaceBelongsToFocus(element, focusedElement, document),
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

function isKeybindingCaptureTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("[data-keybinding-capture]") !== null;
}

export function inputEventDataForPlainTextEdit(edit: PlainTextEdit): string | null {
  return edit.inputType?.startsWith("insert") ? (edit.insertedText ?? "") : null;
}

function dispatchInputEvent(
  control: PlainTextControl,
  inputType: string,
  data: string | null,
): void {
  const InputEventConstructor = control.ownerDocument.defaultView?.InputEvent ?? InputEvent;
  control.dispatchEvent(new InputEventConstructor("input", { bubbles: true, inputType, data }));
}

export function applyEmacsReadlineActionToPlainTextControl(
  control: PlainTextControl,
  action: EmacsReadlineAction,
  yankText: string,
): { readonly handled: boolean; readonly killedText?: string } {
  if (control.disabled || (control.readOnly && MUTATING_ACTIONS.has(action))) {
    return { handled: false };
  }
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
  if (edit.inputType && edit.value !== control.value) {
    control.setRangeText(edit.value, 0, control.value.length, "end");
    control.setSelectionRange(edit.selectionStart, edit.selectionEnd);
    dispatchInputEvent(control, edit.inputType, inputEventDataForPlainTextEdit(edit));
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
  const focus = selection.focusNode;
  return (
    anchor !== null &&
    focus !== null &&
    (anchor === host || host.contains(anchor)) &&
    (focus === host || host.contains(focus))
  );
}

export function applyEmacsReadlineActionToContentEditable(
  host: HTMLElement,
  action: EmacsReadlineAction,
  yankText: string,
): { readonly handled: boolean; readonly killedText?: string } {
  const document = host.ownerDocument;
  const selection = document.getSelection() as SelectionWithModify | null;
  if (
    !selection ||
    !selectionBelongsToHost(selection, host) ||
    selection.rangeCount === 0 ||
    typeof selection.modify !== "function"
  ) {
    return { handled: false };
  }

  const move = (direction: "backward" | "forward", granularity: string) => {
    const hadSelection = !selection.isCollapsed;
    if (hadSelection) {
      const range = selection.getRangeAt(0);
      selection.collapse(
        direction === "backward" ? range.startContainer : range.endContainer,
        direction === "backward" ? range.startOffset : range.endOffset,
      );
    }
    if (hadSelection && granularity === "character") return;
    selection.modify("move", direction, granularity);
  };
  const extendAndDelete = (direction: "backward" | "forward", granularity: string) => {
    if (selection.isCollapsed) selection.modify("extend", direction, granularity);
    if (selection.isCollapsed && direction === "forward" && granularity === "lineboundary") {
      selection.modify("extend", "forward", "character");
    }
    if (selection.isCollapsed) return "";
    const killedText = selection.toString();
    document.execCommand("delete");
    return killedText;
  };
  const restoreRange = (range: Range) => {
    selection.removeAllRanges();
    selection.addRange(range);
  };
  const adjacentCharacter = (
    origin: Range,
    direction: "backward" | "forward",
  ): { readonly range: Range; readonly text: string } | null => {
    restoreRange(origin.cloneRange());
    selection.modify("extend", direction, "character");
    if (selection.isCollapsed || selection.rangeCount === 0) return null;
    const text = selection.toString();
    return text ? { range: selection.getRangeAt(0).cloneRange(), text } : null;
  };
  const transposeCharacters = (): void => {
    if (!selection.isCollapsed) return;
    const original = selection.getRangeAt(0).cloneRange();
    const previous = adjacentCharacter(original, "backward");
    if (!previous) {
      restoreRange(original);
      return;
    }

    const next = adjacentCharacter(original, "forward");
    let before: { readonly range: Range; readonly text: string };
    let after: { readonly range: Range; readonly text: string };
    let endContainer = original.endContainer;
    let endOffset = original.endOffset;
    if (next) {
      before = previous;
      after = next;
      endContainer = next.range.endContainer;
      endOffset = next.range.endOffset;
    } else {
      const previousOrigin = previous.range.cloneRange();
      previousOrigin.collapse(true);
      const previousPrevious = adjacentCharacter(previousOrigin, "backward");
      if (!previousPrevious) {
        restoreRange(original);
        return;
      }
      before = previousPrevious;
      after = previous;
    }

    const transposeRange = document.createRange();
    transposeRange.setStart(before.range.startContainer, before.range.startOffset);
    transposeRange.setEnd(endContainer, endOffset);
    restoreRange(transposeRange);
    document.execCommand("insertText", false, `${after.text}${before.text}`);
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
      if (!selection.isCollapsed) document.execCommand("delete");
      break;
    case "delete-forward":
      if (selection.isCollapsed) selection.modify("extend", "forward", "character");
      if (!selection.isCollapsed) document.execCommand("delete");
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
      if (!yankText) break;
      document.execCommand("insertText", false, yankText);
      break;
    case "transpose-chars":
      transposeCharacters();
      break;
  }

  return { handled: true, ...(killedText === undefined ? {} : { killedText }) };
}

let killRingText = "";
const applicationShortcutYieldEvents = new WeakSet<KeyboardEvent>();
const managedEditorEvents = new WeakSet<KeyboardEvent>();

export function didEmacsReadlineYieldToApplicationShortcut(event: KeyboardEvent): boolean {
  return applicationShortcutYieldEvents.has(event);
}

export function resolveManagedEmacsReadlineAction(
  event: KeyboardEvent,
): EmacsReadlineAction | null {
  return managedEditorEvents.has(event) ? resolveUnclaimedEmacsReadlineAction(event) : null;
}

export function getEmacsReadlineKillRingText(): string {
  return killRingText;
}

export function storeEmacsReadlineKilledText(text: string): void {
  if (text) killRingText = text;
}

export function createEmacsReadlineKeydownHandler(options?: {
  readonly shouldYieldToApplicationShortcut?: (event: KeyboardEvent) => boolean;
}): (event: KeyboardEvent) => void {
  return (event) => {
    const action = resolveEmacsReadlineAction(event);
    if (!action || isTerminalTarget(event.target) || isKeybindingCaptureTarget(event.target)) {
      return;
    }

    const document = (event.target as Node | null)?.ownerDocument ?? globalThis.document;
    if (
      (action === "forward-line" || action === "previous-line") &&
      isCandidateSelectionOpen(document, event.target)
    ) {
      dispatchCandidateNavigation(event, action === "forward-line" ? "ArrowDown" : "ArrowUp");
      return;
    }

    if (options?.shouldYieldToApplicationShortcut?.(event)) {
      applicationShortcutYieldEvents.add(event);
      return;
    }

    const control = getPlainTextControl(event.target);
    const editableHost = control ? null : getContentEditableHost(event.target);
    // Managed editors such as Lexical must update their own selection and
    // document state. Prevent capture-phase application shortcuts from
    // claiming the chord, but allow the original keydown to keep propagating
    // to the editor plugin.
    if (editableHost?.hasAttribute("data-emacs-readline-managed")) {
      if (!editableHost.hasAttribute("data-emacs-readline-ready")) return;
      managedEditorEvents.add(event);
      event.preventDefault();
      return;
    }
    const result = control
      ? applyEmacsReadlineActionToPlainTextControl(control, action, killRingText)
      : editableHost
        ? applyEmacsReadlineActionToContentEditable(editableHost, action, killRingText)
        : { handled: false };

    if (!result.handled) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (result.killedText) storeEmacsReadlineKilledText(result.killedText);
  };
}
