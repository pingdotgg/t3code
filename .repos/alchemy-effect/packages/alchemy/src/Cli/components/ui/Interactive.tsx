/** @jsxImportSource react */
import {
  measureElement,
  useCursor,
  useInput,
  usePaste,
  useStdout,
  type DOMElement,
} from "@alchemy.run/sigil";
import {
  type JSX,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import stringWidth from "string-width";
import type { AwaitExternalOptions, Choice, CycleChoice } from "../types.ts";
import { theme } from "../../../Util/Theme.ts";
import { copyToClipboard, truncate } from "../../../Util/Terminal.ts";
import { useCliEnvironment, useGlyphs, useKeyGlyphs } from "./Environment.tsx";
import { KeyBar, Spinner } from "./Feedback.tsx";
import { Box, overflowListWindow } from "./Layout.tsx";
import { Link, Text } from "./Typography.tsx";

export interface TerminalKey {
  readonly up: boolean;
  readonly down: boolean;
  readonly left: boolean;
  readonly right: boolean;
  readonly home: boolean;
  readonly end: boolean;
  readonly pageUp: boolean;
  readonly pageDown: boolean;
  readonly enter: boolean;
  readonly escape: boolean;
  readonly backspace: boolean;
  readonly delete: boolean;
  readonly tab: boolean;
  readonly shift: boolean;
  readonly ctrl: boolean;
  readonly meta: boolean;
}

/** Backend facade for custom screens; callers never need to import Sigil. */
export const useTerminalInput = (
  handler: (input: string, key: TerminalKey) => void,
  options?: { readonly active?: boolean },
) => {
  return useInput(
    (input, key) =>
      handler(input, {
        up: key.upArrow,
        down: key.downArrow,
        left: key.leftArrow,
        right: key.rightArrow,
        home: key.home,
        end: key.end,
        pageUp: key.pageUp,
        pageDown: key.pageDown,
        enter: key.return,
        escape: key.escape,
        backspace: key.backspace,
        delete: key.delete,
        tab: key.tab,
        shift: key.shift,
        ctrl: key.ctrl,
        meta: key.meta,
      }),
    { isActive: options?.active ?? true },
  );
};

/** Bracketed-paste input scoped the same way as {@link useTerminalInput}. */
export const useTerminalPaste = (
  handler: (text: string) => void,
  options?: { readonly active?: boolean },
) => {
  usePaste(handler, { isActive: options?.active ?? true });
};

export const useTerminalSize = () => {
  const { columns, rows } = useCliEnvironment();
  return { columns, rows };
};

export const useListNavigation = (length: number, initialIndex = 0) => {
  const [cursor, setCursor] = useState(initialIndex);
  const clamped = Math.max(0, Math.min(cursor, Math.max(0, length - 1)));
  const move = (delta: number) =>
    setCursor((current) => {
      if (length === 0) return 0;
      // Clamp before wrapping: after a filter shrinks the list the raw state
      // can point past the end, and wrapping from there jumps arbitrarily.
      const base = Math.max(0, Math.min(current, length - 1));
      return (((base + delta) % length) + length) % length;
    });
  return { cursor: clamped, move, setCursor } as const;
};

/** Step `delta` rows from `cursor`, wrapping and skipping disabled rows. */
export const moveSkippingDisabled = (
  disabled: ReadonlyArray<boolean>,
  cursor: number,
  delta: number,
): number => {
  const length = disabled.length;
  if (length === 0) return 0;
  for (let offset = 1; offset <= length; offset++) {
    const next = (((cursor + delta * offset) % length) + length) % length;
    if (!disabled[next]) return next;
  }
  return cursor;
};

/**
 * Jump to `target` (clamped, no wrap), settling on the nearest enabled row in
 * the jump direction and falling back to the other direction. Used for
 * Home/End and PageUp/PageDown in list prompts.
 */
export const jumpSkippingDisabled = (
  disabled: ReadonlyArray<boolean>,
  cursor: number,
  target: number,
): number => {
  const clamped = Math.max(0, Math.min(disabled.length - 1, target));
  if (!disabled[clamped]) return clamped;
  const direction = clamped >= cursor ? 1 : -1;
  for (
    let next = clamped + direction;
    next >= 0 && next < disabled.length;
    next += direction
  ) {
    if (!disabled[next]) return next;
  }
  for (
    let next = clamped - direction;
    next >= 0 && next < disabled.length;
    next -= direction
  ) {
    if (!disabled[next]) return next;
  }
  return cursor;
};

/** "↑ N more" / "↓ N more" indicator row shared by windowed prompt lists. */
function OverflowRow({
  direction,
  count,
}: {
  readonly direction: "up" | "down";
  readonly count: number;
}) {
  const glyphs = useGlyphs();
  if (count <= 0) return null;
  return (
    <Text tone="muted">
      {" "}
      {direction === "up" ? glyphs.overflowUp : glyphs.overflowDown} {count}{" "}
      more
    </Text>
  );
}

/**
 * List-cursor column shared by every focusable row (prompt lists, the
 * edit-accounts list, the profile dashboard): the focused row carries the
 * pointer glyph, every other row a same-width blank so labels stay aligned.
 * Focus is a shape, not a tint, so it survives ASCII and no-colour terminals.
 */
export function Pointer({ focused }: { readonly focused: boolean }) {
  const glyphs = useGlyphs();
  return (
    <Text color={theme.paint.focus} bold>
      {focused ? glyphs.pointer : " "}
    </Text>
  );
}

/**
 * Focused rows paint their label in the same brand colour as the pointer so
 * the cursor reads as one block; unfocused labels stay the plain foreground,
 * leaving green to status glyphs alone.
 */
const focusedLabelColor = (focused: boolean): string | undefined =>
  focused ? theme.paint.focus : undefined;

/**
 * Width of the label column when descriptions sit beside labels: the widest
 * label plus one cell, so every description starts in the same column
 * (labels and descriptions read as two columns rather than a ragged sentence).
 * Sticky/heading rows are excluded — they never carry a description.
 */
const labelColumnWidth = (
  labels: ReadonlyArray<{ readonly label: string; readonly sticky?: boolean }>,
): number =>
  Math.max(
    0,
    ...labels.map(({ label, sticky }) => (sticky ? 0 : stringWidth(label))),
  ) + 1;

export interface MenuProps<Value> {
  readonly choices: ReadonlyArray<Choice<Value>>;
  readonly cursor: number;
  readonly selected?: ReadonlySet<number>;
  readonly visibleCount?: number;
  readonly empty?: string;
  readonly descriptionPlacement?: "below" | "inline";
}

/** Pure menu presentation used by select prompts and custom applications. */
export function Menu<Value>({
  choices,
  cursor,
  selected,
  visibleCount = 12,
  empty = "No choices.",
  descriptionPlacement = "inline",
}: MenuProps<Value>): JSX.Element {
  const glyphs = useGlyphs();
  if (choices.length === 0) return <Text tone="muted">{empty}</Text>;
  // A sticky heading renders outside the window, in addition to the overflow
  // rows the shared windowing already reserves.
  const { start, end } = overflowListWindow(
    choices.length,
    cursor,
    visibleCount,
  );
  const stickyIndex =
    start === 0
      ? -1
      : choices.findLastIndex(
          (choice, index) => index < start && choice.sticky,
        );
  const visible = [
    ...(stickyIndex === -1 ? [] : [stickyIndex]),
    ...Array.from({ length: end - start }, (_, offset) => start + offset),
  ];
  const alignDescriptions =
    descriptionPlacement === "inline" &&
    choices.some((choice) => choice.description !== undefined);
  const labelWidth = alignDescriptions ? labelColumnWidth(choices) : undefined;
  return (
    <Box
      flexDirection="column"
      aria-role="listbox"
      aria-state={{ multiselectable: selected !== undefined }}
    >
      <OverflowRow direction="up" count={start} />
      {visible.map((index) => {
        const choice = choices[index];
        if (choice === undefined) return null;
        const focused = index === cursor;
        const checked = selected?.has(index);
        const disabled =
          choice.disabled !== undefined && choice.disabled !== false;
        const previous = choices[index - 1];
        const showGroup =
          choice.group !== undefined &&
          (index === start || previous?.group !== choice.group);
        return (
          <Box
            key={index}
            flexDirection="column"
            marginTop={showGroup && index !== visible[0] ? 1 : 0}
          >
            {showGroup ? (
              <Box paddingLeft={theme.space.indent}>
                <Text bold tone="muted">
                  {choice.group.toUpperCase()}
                </Text>
              </Box>
            ) : null}
            <Box
              gap={1}
              paddingRight={1}
              paddingLeft={choice.indent ?? 0}
              aria-role="option"
              aria-label={choice.label}
              aria-state={{
                disabled,
                selected: selected === undefined ? focused : checked,
              }}
            >
              <Pointer focused={focused} />
              {selected === undefined ? null : (
                <Text
                  color={checked ? theme.color.success : theme.color.muted}
                  dimColor={disabled}
                >
                  {checked ? glyphs.checked : glyphs.unchecked}
                </Text>
              )}
              <Box
                flexDirection={
                  descriptionPlacement === "inline" ? "row" : "column"
                }
                flexGrow={1}
                gap={descriptionPlacement === "inline" ? 1 : 0}
              >
                <Box
                  width={choice.sticky ? undefined : labelWidth}
                  flexShrink={0}
                >
                  <Text
                    bold={focused || choice.sticky || checked}
                    color={
                      focusedLabelColor(focused) ??
                      (choice.tone === "info" ? theme.color.info : undefined)
                    }
                    dimColor={disabled}
                  >
                    {choice.label}
                  </Text>
                </Box>
                {choice.description === undefined ? null : (
                  <Text tone="muted" wrap="truncate-end">
                    {choice.description}
                  </Text>
                )}
              </Box>
              {typeof choice.disabled === "string" ? (
                <Text tone="muted">{choice.disabled}</Text>
              ) : null}
            </Box>
          </Box>
        );
      })}
      <OverflowRow direction="down" count={choices.length - end} />
    </Box>
  );
}

export interface TextFieldProps {
  readonly placeholder?: string;
  readonly initialValue?: string;
  readonly value?: string;
  readonly mask?: string;
  readonly onSubmit: (value: string) => void;
  readonly onChange?: (value: string) => void;
  readonly onCancel?: () => void;
  readonly active?: boolean;
  readonly ariaLabel?: string;
}

const graphemeSegmenter = new Intl.Segmenter();

/**
 * Split into user-perceived characters so cursor movement and deletion never
 * land inside a surrogate pair or emoji cluster.
 */
const toGraphemes = (value: string): ReadonlyArray<string> =>
  Array.from(graphemeSegmenter.segment(value), (segment) => segment.segment);

/**
 * Normalize text before inserting it into a single-line field. Sigil reports
 * bracketed paste separately, but pasted content can still contain newlines,
 * tabs or other control characters that do not belong in the value.
 */
export const sanitizeTextInsert = (input: string): string =>
  // eslint-disable-next-line no-control-regex
  input.replace(/[\u0000-\u001f\u007f]/g, "");

/** Readline-style whitespace word boundary to the left of `cursor`. */
const wordBoundaryLeft = (
  chars: ReadonlyArray<string>,
  cursor: number,
): number => {
  let index = cursor;
  while (index > 0 && chars[index - 1] === " ") index--;
  while (index > 0 && chars[index - 1] !== " ") index--;
  return index;
};

/** Readline-style whitespace word boundary to the right of `cursor`. */
const wordBoundaryRight = (
  chars: ReadonlyArray<string>,
  cursor: number,
): number => {
  let index = cursor;
  while (index < chars.length && chars[index] === " ") index++;
  while (index < chars.length && chars[index] !== " ") index++;
  return index;
};

/**
 * Horizontal scroll window for a single-line field: which grapheme range fits
 * in `avail` display cells while keeping the cursor visible. One cell is
 * reserved for the cursor sitting past the last character.
 */
const visibleWindow = (
  chars: ReadonlyArray<string>,
  cursor: number,
  avail: number,
): { readonly start: number; readonly end: number } => {
  const budget = Math.max(1, avail - 1);
  const widths = chars.map((char) => stringWidth(char));
  let before = 0;
  for (let index = 0; index < cursor; index++) before += widths[index] ?? 0;
  let start = 0;
  if (before > budget) {
    // Scrolled: pin the cursor near the right edge of the window.
    let used = 0;
    while (start < cursor && before - used > budget) {
      used += widths[start] ?? 0;
      start++;
    }
  }
  let end = start;
  let total = 0;
  while (end < chars.length && total + (widths[end] ?? 0) <= budget) {
    total += widths[end] ?? 0;
    end++;
  }
  return { start, end };
};

/**
 * Single-line editor with insertion, deletion, home/end, word-wise movement
 * and the common readline kill bindings (Ctrl+U/K/W, Alt+Backspace). Long
 * values scroll horizontally instead of wrapping, so the terminal cursor
 * always sits on the field's own row.
 */
export function TextField({
  placeholder,
  initialValue = "",
  value: controlledValue,
  mask,
  onSubmit,
  onChange,
  onCancel,
  active,
  ariaLabel,
}: TextFieldProps) {
  // Prompts are serialized by the CliKit runtime, so an enabled field owns
  // the input stream outright — no Sigil focus negotiation. (Coupling this to
  // useFocus({autoFocus}) silently disabled the field whenever any other
  // focusable was already mounted.)
  const inputActive = active ?? true;
  const [internalValue, setInternalValue] = useState(initialValue);
  const value = controlledValue ?? internalValue;
  const chars = toGraphemes(value);
  const [cursor, setCursor] = useState(
    () => toGraphemes(controlledValue ?? initialValue).length,
  );
  const fieldRef = useRef<DOMElement>(null);
  const [metrics, setMetrics] = useState({ x: 0, y: 0, measured: false });
  const { setCursorPosition } = useCursor();
  const { columns } = useCliEnvironment();
  useEffect(() => {
    setCursor((current) => Math.min(current, toGraphemes(value).length));
  }, [value]);
  const update = (nextChars: ReadonlyArray<string>, nextCursor: number) => {
    const next = nextChars.join("");
    if (controlledValue === undefined) setInternalValue(next);
    setCursor(Math.max(0, Math.min(nextChars.length, nextCursor)));
    onChange?.(next);
  };
  useTerminalInput(
    (input, key) => {
      if (key.enter) onSubmit(value);
      else if (key.escape) onCancel?.();
      else if (key.left)
        setCursor(
          key.ctrl || key.meta
            ? wordBoundaryLeft(chars, cursor)
            : Math.max(0, cursor - 1),
        );
      else if (key.right)
        setCursor(
          key.ctrl || key.meta
            ? wordBoundaryRight(chars, cursor)
            : Math.min(chars.length, cursor + 1),
        );
      // Sigil distinguishes physical Backspace from Delete.
      else if (key.backspace && cursor > 0) {
        const target = key.meta ? wordBoundaryLeft(chars, cursor) : cursor - 1;
        update([...chars.slice(0, target), ...chars.slice(cursor)], target);
      } else if (key.delete && cursor < chars.length)
        update([...chars.slice(0, cursor), ...chars.slice(cursor + 1)], cursor);
      else if (key.ctrl && input === "d" && cursor < chars.length)
        update([...chars.slice(0, cursor), ...chars.slice(cursor + 1)], cursor);
      else if (key.ctrl && input === "w" && cursor > 0) {
        const target = wordBoundaryLeft(chars, cursor);
        update([...chars.slice(0, target), ...chars.slice(cursor)], target);
      } else if (key.ctrl && input === "u") update(chars.slice(cursor), 0);
      else if (key.ctrl && input === "k")
        update(chars.slice(0, cursor), cursor);
      else if (key.home || (key.ctrl && input === "a")) setCursor(0);
      else if (key.end || (key.ctrl && input === "e")) setCursor(chars.length);
      else if (key.meta && input === "b")
        setCursor(wordBoundaryLeft(chars, cursor));
      else if (key.meta && input === "f")
        setCursor(wordBoundaryRight(chars, cursor));
      else if (!key.ctrl && !key.meta && !key.tab) {
        const inserted = toGraphemes(sanitizeTextInsert(input));
        if (inserted.length > 0) {
          update(
            [...chars.slice(0, cursor), ...inserted, ...chars.slice(cursor)],
            cursor + inserted.length,
          );
        }
      }
    },
    { active: inputActive },
  );
  useTerminalPaste(
    (pasted) => {
      const inserted = toGraphemes(sanitizeTextInsert(pasted));
      if (inserted.length === 0) return;
      update(
        [...chars.slice(0, cursor), ...inserted, ...chars.slice(cursor)],
        cursor + inserted.length,
      );
    },
    { active: inputActive },
  );
  const shownChars = mask === undefined ? chars : chars.map(() => mask);
  // Available width = terminal width minus the field's left offset. The box's
  // own measured width is useless here: it shrinks to its content (flexGrow
  // only affects height in a column parent), so using it collapses the scroll
  // window to whatever is currently typed.
  const avail = Math.max(4, columns - (metrics.measured ? metrics.x : 0) - 1);
  const { start, end } = visibleWindow(shownChars, cursor, avail);
  const display =
    shownChars.length === 0
      ? (placeholder ?? " ")
      : `${shownChars.slice(start, end).join("")}${cursor === shownChars.length ? " " : ""}`;
  // Cursor placement must happen DURING render: useCursor only records the
  // position in a ref and propagates it to the renderer from an insertion
  // effect, which runs BEFORE layout effects in the same commit. Setting the
  // position from a layout effect therefore paints every frame with the
  // previous keystroke's cursor (off by one while typing and erasing). The
  // ref write is render-safe — propagation is commit-gated, so abandoned
  // concurrent renders never reach the terminal.
  setCursorPosition(
    inputActive && metrics.measured
      ? {
          x: metrics.x + stringWidth(shownChars.slice(start, cursor).join("")),
          y: metrics.y,
        }
      : undefined,
  );
  // Measuring stays post-layout: the Box ref only exists after mutation.
  // A metrics change re-renders, which re-runs the render-time cursor
  // placement above with the fresh offsets.
  useLayoutEffect(() => {
    if (fieldRef.current === null) return;
    const { x, y } = measureElement(fieldRef.current);
    setMetrics((current) =>
      current.measured && current.x === x && current.y === y
        ? current
        : { x, y, measured: true },
    );
  });
  return (
    <Box ref={fieldRef} aria-role="textbox" aria-label={ariaLabel}>
      <Text
        tone={shownChars.length === 0 ? "muted" : "default"}
        wrap="truncate-end"
      >
        {display}
      </Text>
    </Box>
  );
}

export interface CycleListProps<State> {
  readonly choices: ReadonlyArray<CycleChoice<State>>;
  readonly cursor: number;
  readonly indices: ReadonlyArray<number>;
  readonly visibleCount?: number;
}

const stateColor = (
  variant: CycleChoice<unknown>["states"][number]["variant"],
) =>
  variant === undefined || variant === "neutral"
    ? undefined
    : theme.color[variant === "error" ? "danger" : variant];

export function CycleList<State>({
  choices,
  cursor,
  indices,
  visibleCount = 12,
}: CycleListProps<State>) {
  const glyphs = useGlyphs();
  const { start, end } = overflowListWindow(
    choices.length,
    cursor,
    visibleCount,
  );
  const labelWidth = labelColumnWidth(choices);
  // The state word ("add", "remove", …) gets its own column too, so the
  // descriptions line up whether or not a row's current state carries one.
  const stateWidth = Math.max(
    0,
    ...choices.flatMap((choice) =>
      choice.states.map((state) =>
        state.label === undefined ? 0 : stringWidth(state.label),
      ),
    ),
  );
  return (
    <Box flexDirection="column">
      <OverflowRow direction="up" count={start} />
      {choices.slice(start, end).map((choice, offset) => {
        const index = start + offset;
        const state = choice.states[indices[index] ?? 0];
        const focused = index === cursor;
        const color = stateColor(state?.variant);
        return (
          <Box key={index} gap={1} paddingRight={1}>
            <Pointer focused={focused} />
            <Text color={color} dimColor={color === undefined}>
              {state?.icon ?? glyphs.bullet}
            </Text>
            <Box width={labelWidth} flexShrink={0}>
              <Text bold color={focusedLabelColor(focused)}>
                {choice.label}
              </Text>
            </Box>
            {stateWidth === 0 ? null : (
              <Box width={stateWidth} flexShrink={0}>
                {state?.label === undefined ? null : (
                  <Text color={color}>{state.label}</Text>
                )}
              </Box>
            )}
            {choice.description === undefined ? null : (
              <Text tone="muted">{choice.description}</Text>
            )}
          </Box>
        );
      })}
      <OverflowRow direction="down" count={choices.length - end} />
    </Box>
  );
}

export const useCycleNavigation = (stateCounts: ReadonlyArray<number>) => {
  const { cursor, move, setCursor } = useListNavigation(stateCounts.length);
  const [indices, setIndices] = useState<ReadonlyArray<number>>(() =>
    stateCounts.map(() => 0),
  );
  const cycle = (delta: number) =>
    setIndices((current) =>
      current.map((value, index) => {
        if (index !== cursor) return value;
        const count = stateCounts[index] ?? 0;
        return count <= 0 ? 0 : (value + delta + count) % count;
      }),
    );
  return { cursor, indices, move, setCursor, cycle } as const;
};

export interface ExternalWaitProps extends AwaitExternalOptions {
  readonly onSubmit: (value: string) => void;
  readonly onCancel: () => void;
}

/**
 * Yes/no keyboard handling shared by `InlineConfirm` and the confirm prompt
 * screen: arrows/tab toggle, Enter commits, y/n answer directly.
 */
export const useConfirmKeys = ({
  initialValue = false,
  active,
  onSubmit,
  onCancel,
}: {
  readonly initialValue?: boolean;
  readonly active?: boolean;
  readonly onSubmit: (value: boolean) => void;
  readonly onCancel?: () => void;
}): boolean => {
  const [value, setValue] = useState(initialValue);
  useTerminalInput(
    (input, key) => {
      if (key.escape) onCancel?.();
      else if (key.left || key.right || key.tab || key.up || key.down)
        setValue((current) => !current);
      else if (key.enter) onSubmit(value);
      else if (key.ctrl || key.meta) return;
      else if (input.toLowerCase() === "y") onSubmit(true);
      else if (input.toLowerCase() === "n") onSubmit(false);
    },
    { active: active ?? true },
  );
  return value;
};

type InlineConfirmProps = {
  readonly message: string;
  readonly initialValue?: boolean;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  readonly active?: boolean;
  readonly onSubmit: (value: boolean) => void;
  readonly onCancel?: () => void;
};

export function InlineConfirm({
  message,
  initialValue = false,
  confirmLabel = "Yes",
  cancelLabel = "No",
  active,
  onSubmit,
  onCancel,
}: InlineConfirmProps) {
  const keys = useKeyGlyphs();
  const value = useConfirmKeys({ initialValue, active, onSubmit, onCancel });
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold color={theme.color.brand}>
        {message}
      </Text>
      <ChoiceGroup
        value={value}
        choices={[
          { value: true, label: confirmLabel },
          { value: false, label: cancelLabel },
        ]}
      />
      <KeyBar
        marginTop={0}
        keys={[
          [
            confirmLabel === "Yes" && cancelLabel === "No"
              ? keys.yesNo
              : keys.leftRight,
            "choose",
          ],
          [keys.enter, "confirm"],
          [keys.escape, "cancel"],
        ]}
      />
    </Box>
  );
}

export interface ChoiceGroupProps<Value> {
  readonly choices: ReadonlyArray<{
    readonly value: Value;
    readonly label: string;
    readonly description?: string;
  }>;
  readonly value: Value;
  readonly orientation?: "horizontal" | "vertical";
  readonly active?: boolean;
  readonly onChange?: (value: Value) => void;
}

export function ChoiceGroup<Value>({
  choices,
  value,
  orientation = "horizontal",
  active = true,
  onChange,
}: ChoiceGroupProps<Value>) {
  const selected = Math.max(
    0,
    choices.findIndex((choice) => choice.value === value),
  );
  useTerminalInput(
    (_input, key) => {
      if (onChange === undefined || choices.length === 0) return;
      const previous =
        key.tab && key.shift
          ? true
          : orientation === "horizontal"
            ? key.left
            : key.up;
      const next =
        key.tab || (orientation === "horizontal" ? key.right : key.down);
      if (!previous && !next) return;
      const delta = previous ? -1 : 1;
      const index = (selected + delta + choices.length) % choices.length;
      onChange(choices[index]!.value);
    },
    { active: active && onChange !== undefined },
  );
  return (
    <Box
      gap={orientation === "horizontal" ? 1 : 0}
      paddingLeft={theme.space.indent}
      flexDirection={orientation === "horizontal" ? "row" : "column"}
      aria-role="radiogroup"
    >
      {choices.map((choice) => {
        const selected = choice.value === value;
        return (
          <Box
            key={choice.label}
            paddingX={1}
            backgroundColor={selected ? theme.paint.interactive : undefined}
            aria-role="radio"
            aria-label={choice.label}
            aria-state={{ checked: selected }}
          >
            <Text
              bold={selected}
              color={selected ? theme.color.onAccent : undefined}
            >
              {choice.label}
            </Text>
            {choice.description === undefined ? null : (
              <Text tone="muted"> · {choice.description}</Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

/** Browser/OAuth waiting screen with URL controls and manual-entry fallback. */
export function ExternalWait({
  message,
  waitingLabel,
  url,
  code,
  openFailed = false,
  onOpen,
  allowManualInput = true,
  inputLabel,
  placeholder,
  validate,
  onSubmit,
  onCancel,
}: ExternalWaitProps) {
  const { stdout } = useStdout();
  const glyphs = useGlyphs();
  const keyGlyphs = useKeyGlyphs();
  const [manual, setManual] = useState(false);
  const [showFull, setShowFull] = useState(false);
  const [copied, setCopied] = useState(false);
  const [browserFailed, setBrowserFailed] = useState(openFailed);
  const [error, setError] = useState<string>();
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(
    () => () => {
      clearTimeout(copiedTimer.current);
    },
    [],
  );
  const { columns } = useTerminalSize();
  // Ctrl+C is handled centrally by the screen runner (SigilRuntime.run).
  useTerminalInput((input, key) => {
    if (manual) {
      if (key.escape) {
        setError(undefined);
        setManual(false);
      }
      return;
    }
    const shortcut = input.toLowerCase();
    if (key.enter && allowManualInput) setManual(true);
    else if (key.escape) onCancel();
    // Ctrl+C must fall through to the runner's cancel guard, not copy the URL.
    else if (key.ctrl || key.meta) return;
    else if (shortcut === "u") setShowFull((current) => !current);
    else if (shortcut === "o" && onOpen !== undefined) {
      setBrowserFailed(false);
      void onOpen().catch(() => setBrowserFailed(true));
    } else if (shortcut === "c" && (code ?? url) !== undefined) {
      copyToClipboard(code ?? url!, stdout ?? process.stdout);
      setCopied(true);
      clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 2000);
    }
  });
  if (manual) {
    const manualInputLabel =
      inputLabel ?? "Paste the authorization code or callback URL";
    return (
      <PromptFrame
        message={manualInputLabel}
        layout="inline"
        error={error}
        keys={[
          [keyGlyphs.enter, "confirm"],
          [keyGlyphs.escape, "back to waiting"],
        ]}
      >
        <TextField
          placeholder={placeholder}
          ariaLabel={manualInputLabel}
          onCancel={() => {
            setError(undefined);
            setManual(false);
          }}
          onChange={() => setError(undefined)}
          onSubmit={(value) => {
            const problem = validate?.(value);
            if (problem !== undefined) {
              setError(problem instanceof Error ? problem.message : problem);
            } else {
              onSubmit(value);
            }
          }}
        />
      </PromptFrame>
    );
  }
  return (
    <PromptFrame
      message={message}
      keys={[
        ...(allowManualInput
          ? ([[keyGlyphs.enter, "enter code manually"]] as const)
          : []),
        ...(url === undefined
          ? []
          : ([
              ...(onOpen === undefined
                ? []
                : ([["o", "open browser"]] as const)),
              [
                "c",
                copied
                  ? `${glyphs.success} copied`
                  : code === undefined
                    ? "copy URL"
                    : "copy code",
              ],
              ["u", showFull ? "collapse URL" : "full URL"],
            ] as const)),
        [keyGlyphs.escape, "cancel"],
      ]}
    >
      <Box flexDirection="column" gap={1}>
        <Spinner label={waitingLabel} />
        {code === undefined ? null : (
          <Box gap={1}>
            <Text tone="muted">Code</Text>
            <Text bold color={theme.color.accentBright}>
              {code}
            </Text>
          </Box>
        )}
        {browserFailed ? (
          <Text tone="warning">
            {glyphs.warning} Could not open the browser. Copy and open the URL
            manually.
          </Text>
        ) : null}
        {url === undefined ? null : (
          <Link href={url}>
            {showFull ? url : truncate(url, Math.max(24, columns - 8))}
          </Link>
        )}
      </Box>
    </PromptFrame>
  );
}

export type PromptFrameProps = {
  readonly message: string;
  readonly description?: ReactNode;
  readonly children: JSX.Element;
  readonly layout?: "inline" | "stacked";
  readonly error?: string;
  readonly keys?: ReadonlyArray<readonly [string, string]>;
};

export function PromptFrame({
  message,
  description,
  children,
  layout = "stacked",
  error,
  keys,
}: PromptFrameProps) {
  const glyphs = useGlyphs();
  // The active-step glyph shares the heading's brand colour: `◆ question` is
  // the step being answered, `✓ question` (AnsweredPrompt) one that is done.
  const heading = (suffix = "") => (
    <Text>
      <Text bold color={theme.color.brand}>
        {glyphs.active} {message}
        {suffix}
      </Text>
    </Text>
  );
  return (
    <Box flexDirection="column">
      {layout === "inline" ? (
        <Box flexDirection="column">
          <Box gap={1}>
            {heading(":")}
            <Box flexGrow={1}>{children}</Box>
          </Box>
          {description === undefined ? null : (
            <Box paddingLeft={theme.space.indent}>
              <Text tone="muted">{description}</Text>
            </Box>
          )}
        </Box>
      ) : (
        <>
          {heading()}
          {description === undefined ? null : (
            <Box paddingLeft={theme.space.indent}>
              <Text tone="muted">{description}</Text>
            </Box>
          )}
          {/* Children sit directly under the heading, indented like the
              answered lines' text; grouping is carried by indentation, not
              by a rail. */}
          <Box paddingLeft={theme.space.indent} flexDirection="column">
            {children}
          </Box>
        </>
      )}
      {error === undefined ? null : (
        <Box marginTop={1} paddingLeft={2}>
          <Text color={theme.color.danger}>
            {glyphs.error} {error}
          </Text>
        </Box>
      )}
      {keys === undefined ? null : <KeyBar keys={keys} />}
    </Box>
  );
}

export const filterChoices = <Value,>(
  choices: ReadonlyArray<Choice<Value>>,
  query: string,
) => {
  const normalized = query.trim().toLowerCase();
  const indexed = choices.map((choice, index) => ({ choice, index }));
  return normalized === ""
    ? indexed
    : indexed.filter(({ choice }) =>
        `${choice.group ?? ""} ${choice.label} ${choice.description ?? ""}`
          .toLowerCase()
          .includes(normalized),
      );
};

/** Stable selected-index set for multiselect widgets. */
export const useSelectedChoices = <Value,>(
  choices: ReadonlyArray<Choice<Value>>,
  initialValues: ReadonlyArray<Value>,
) => {
  return useState<ReadonlySet<number>>(
    () =>
      new Set(
        initialValues.flatMap((value) => {
          const index = choices.findIndex((choice) => choice.value === value);
          return index === -1 || choices[index]?.disabled ? [] : [index];
        }),
      ),
  );
};
