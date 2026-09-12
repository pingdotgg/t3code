/** @jsxImportSource react */
import { type ReactNode, useEffect, useMemo, useState } from "react";
import type {
  ConfirmOptions,
  CycleSelectOptions,
  AwaitExternalOptions,
  MenuOptions,
  MultiSelectOptions,
  PasswordInputOptions,
  Screen,
  ScreenController,
  SelectOptions,
  TextInputOptions,
} from "../types.ts";
import { useGlyphs, useKeyGlyphs } from "../ui/Environment.tsx";
import { Alert } from "../ui/Feedback.tsx";
import {
  ChoiceGroup,
  filterChoices,
  CycleList,
  ExternalWait,
  jumpSkippingDisabled,
  Menu,
  moveSkippingDisabled,
  PromptFrame,
  sanitizeTextInsert,
  TextField,
  useConfirmKeys,
  useListNavigation,
  useSelectedChoices,
  useTerminalInput,
  useTerminalPaste,
  useTerminalSize,
  useCycleNavigation,
  type TerminalKey,
} from "../ui/Interactive.tsx";
import { Box } from "../ui/Layout.tsx";
import { AnsweredPrompt } from "../ui/Transcript.tsx";
import { Text } from "../ui/Typography.tsx";

const errorMessage = (value: string | Error | undefined) =>
  value instanceof Error ? value.message : value;

const answerText = (value: string, maskGlyph?: string) => {
  if (maskGlyph !== undefined) {
    return maskGlyph.repeat(Math.min(value.length, 12));
  }
  return value || "(empty)";
};

/**
 * Escape-to-cancel for standard prompts. Ctrl+C is handled centrally by the
 * screen runner (SigilRuntime.run), so screens only wire Escape semantics.
 */
const useCancel = (cancel: () => void) =>
  useTerminalInput((_input, key) => {
    if (key.escape) cancel();
  });

/** One `Screen` factory shape shared by the non-generic prompt screens. */
const screen =
  <Options, Value>(
    name: string,
    Component: (
      props: { readonly options: Options } & ScreenController<Value>,
    ) => ReactNode,
  ) =>
  (options: Options): Screen<Value> => ({
    name,
    render: (controller) => <Component options={options} {...controller} />,
  });

/**
 * Scaffolding shared by the select and multi-select prompts: cursor state
 * clamped onto enabled rows, the navigation key ladder (arrows, `j`/`k` when
 * not searchable, Home/End, PageUp/PageDown), Escape-clears-filter-then-
 * cancels, filter editing, and bracketed paste into the filter. Callers run
 * their own submit/toggle keys first and delegate the rest to `handleKey`.
 */
const useChoiceList = ({
  disabled,
  searchable,
  visibleCount,
  query,
  setQuery,
  onCancel,
  initialCursor = 0,
}: {
  readonly disabled: ReadonlyArray<boolean>;
  readonly searchable: boolean;
  readonly visibleCount: number;
  readonly query: string;
  readonly setQuery: (query: string) => void;
  readonly onCancel: () => void;
  readonly initialCursor?: number;
}) => {
  const { cursor, setCursor } = useListNavigation(
    disabled.length,
    initialCursor,
  );
  useEffect(() => {
    setCursor((current) => {
      if (disabled.length === 0) return 0;
      const clamped = Math.min(current, disabled.length - 1);
      if (!disabled[clamped]) return clamped;
      const enabled = disabled.findIndex((value) => !value);
      return enabled === -1 ? clamped : enabled;
    });
  }, [disabled, setCursor]);
  const page = Math.max(1, visibleCount);
  const resetFilter = (next: string) => {
    setQuery(next);
    setCursor(0);
  };
  /** Returns true when the keystroke was consumed. */
  const handleKey = (input: string, key: TerminalKey): boolean => {
    const plain = !key.ctrl && !key.meta;
    if (key.up || (!searchable && plain && input === "k"))
      setCursor(moveSkippingDisabled(disabled, cursor, -1));
    else if (key.down || (!searchable && plain && input === "j"))
      setCursor(moveSkippingDisabled(disabled, cursor, 1));
    else if (key.home) setCursor(jumpSkippingDisabled(disabled, cursor, 0));
    else if (key.end)
      setCursor(jumpSkippingDisabled(disabled, cursor, disabled.length - 1));
    else if (key.pageUp)
      setCursor(jumpSkippingDisabled(disabled, cursor, cursor - page));
    else if (key.pageDown)
      setCursor(jumpSkippingDisabled(disabled, cursor, cursor + page));
    else if (key.escape) {
      // An active filter absorbs the first Escape; the second cancels.
      if (query !== "") resetFilter("");
      else onCancel();
    } else if (searchable && (key.backspace || key.delete))
      resetFilter(query.slice(0, -1));
    else if (searchable && plain && !key.tab) {
      const typed = sanitizeTextInsert(input);
      if (typed.length === 0) return false;
      resetFilter(query + typed);
    } else return false;
    return true;
  };
  useTerminalPaste(
    (pasted) => {
      const typed = sanitizeTextInsert(pasted);
      if (typed.length > 0) resetFilter(query + typed);
    },
    { active: searchable },
  );
  return { cursor, setCursor, handleKey } as const;
};

/**
 * fzf-style query row for searchable lists: a `/` prefix, the typed text
 * with a block cursor, and a right-hand annotation (match count, selection
 * count). The row is always present so the list does not jump when the first
 * character is typed.
 */
function FilterLine({
  query,
  annotation,
}: {
  readonly query: string;
  readonly annotation: string;
}) {
  return (
    <Box gap={2}>
      <Text>
        <Text tone="muted">/ </Text>
        {query === "" ? (
          <Text tone="muted">type to filter</Text>
        ) : (
          <>
            {query}
            <Text inverse> </Text>
          </>
        )}
      </Text>
      <Text tone="muted">{annotation}</Text>
    </Box>
  );
}

type TextPromptProps = {
  readonly options: TextInputOptions | PasswordInputOptions;
  readonly mask?: boolean;
  readonly submit: (value: string, summary?: ReactNode) => void;
  readonly cancel: () => void;
};

function TextPrompt({ options, mask, submit, cancel }: TextPromptProps) {
  const glyphs = useGlyphs();
  const keys = useKeyGlyphs();
  const maskGlyph = mask ? glyphs.mask : undefined;
  const [error, setError] = useState<string>();
  useCancel(cancel);
  const complete = (raw: string) => {
    const value =
      raw === "" &&
      "defaultValue" in options &&
      options.defaultValue !== undefined
        ? options.defaultValue
        : raw;
    const problem = errorMessage(options.validate?.(value));
    if (problem !== undefined) setError(problem);
    else
      submit(
        value,
        <AnsweredPrompt
          message={options.message}
          answer={answerText(value, maskGlyph)}
        />,
      );
  };
  return (
    <PromptFrame
      message={options.message}
      description={options.description}
      layout={options.layout ?? "inline"}
      error={error}
      keys={[
        [keys.enter, "confirm"],
        [keys.escape, "cancel"],
      ]}
    >
      <TextField
        // A default is the value Enter will submit, so show it in the empty
        // field when the caller did not supply more specific hint text.
        // Keep it a placeholder (rather than initialValue) so the first
        // keystroke starts a replacement instead of appending to the default.
        placeholder={
          options.placeholder ??
          ("defaultValue" in options ? options.defaultValue : undefined)
        }
        initialValue={
          "initialValue" in options ? options.initialValue : undefined
        }
        mask={maskGlyph}
        ariaLabel={options.message}
        onChange={() => setError(undefined)}
        onSubmit={complete}
      />
    </PromptFrame>
  );
}

export const textScreen = screen<TextInputOptions, string>(
  "text input",
  TextPrompt,
);

export const passwordScreen = screen<PasswordInputOptions, string>(
  "password input",
  (props) => <TextPrompt {...props} mask />,
);

type SelectPromptProps<Value> = {
  readonly options: SelectOptions<Value>;
  readonly submit: (value: Value, summary?: ReactNode) => void;
  readonly cancel: () => void;
  readonly summary?: boolean;
  readonly header?: ReactNode;
  readonly footer?: ReactNode;
  readonly escapeLabel?: string;
};

function SelectPrompt<Value>({
  options,
  submit,
  cancel,
  summary = true,
  header,
  footer,
  escapeLabel = "cancel",
}: SelectPromptProps<Value>) {
  const keys = useKeyGlyphs();
  const { rows } = useTerminalSize();
  const visibleCount =
    options.visibleCount ?? Math.max(3, Math.min(16, rows - 8));
  const searchable = options.searchable === true;
  const [query, setQuery] = useState("");
  const filtered = useMemo(
    () =>
      searchable
        ? filterChoices(options.options, query)
        : options.options.map((choice, index) => ({ choice, index })),
    [options.options, query, searchable],
  );
  const initialOriginalIndex = options.options.findIndex(
    (choice) => choice.value === options.initialValue,
  );
  const initialIndex = filtered.findIndex(
    ({ index }) => index === initialOriginalIndex,
  );
  const firstEnabled = filtered.findIndex(({ choice }) => !choice.disabled);
  const disabled = useMemo(
    () =>
      filtered.map(
        ({ choice }) =>
          choice.disabled !== undefined && choice.disabled !== false,
      ),
    [filtered],
  );
  const { cursor, handleKey } = useChoiceList({
    disabled,
    searchable,
    visibleCount,
    query,
    setQuery,
    onCancel: cancel,
    initialCursor:
      initialIndex !== -1 && !filtered[initialIndex]?.choice.disabled
        ? initialIndex
        : Math.max(0, firstEnabled),
  });
  useTerminalInput((input, key) => {
    if (key.enter) {
      const choice = filtered[cursor]?.choice;
      if (choice !== undefined && !choice.disabled) {
        submit(
          choice.value,
          summary ? (
            <AnsweredPrompt message={options.message} answer={choice.label} />
          ) : undefined,
        );
      }
      return;
    }
    handleKey(input, key);
  });
  return (
    <Box flexDirection="column" gap={1}>
      {header}
      <PromptFrame
        message={options.message}
        keys={[
          [keys.upDown, "navigate"],
          [keys.enter, "select"],
          [keys.escape, query === "" ? escapeLabel : "clear filter"],
        ]}
      >
        <Box flexDirection="column">
          {searchable ? (
            <FilterLine
              query={query}
              annotation={
                query === ""
                  ? `${options.options.length} choices`
                  : `${filtered.length} of ${options.options.length}`
              }
            />
          ) : null}
          <Menu
            choices={filtered.map(({ choice }) => choice)}
            cursor={cursor}
            visibleCount={visibleCount}
            empty="No matching choices."
            descriptionPlacement={options.descriptionPlacement}
          />
        </Box>
      </PromptFrame>
      {footer}
    </Box>
  );
}

export const selectScreen = <Value,>(
  options: SelectOptions<Value>,
): Screen<Value> => ({
  name: "selection",
  render: ({ submit, cancel }) => (
    <SelectPrompt options={options} submit={submit} cancel={cancel} />
  ),
});

export const menuScreen = <Value,>(
  options: MenuOptions<Value>,
): Screen<Value> => {
  const hasBack = Object.hasOwn(options, "back");
  return {
    name: "menu",
    render: ({ submit, cancel }) => (
      <SelectPrompt
        options={options}
        submit={submit}
        cancel={() => (hasBack ? submit(options.back as Value) : cancel())}
        summary={false}
        header={options.header}
        footer={options.footer}
        escapeLabel={hasBack ? "back" : "exit"}
      />
    ),
  };
};

type MultiSelectPromptProps<Value> = {
  readonly options: MultiSelectOptions<Value>;
  readonly submit: (value: ReadonlyArray<Value>, summary?: ReactNode) => void;
  readonly cancel: () => void;
};

function MultiSelectPrompt<Value>({
  options,
  submit,
  cancel,
}: MultiSelectPromptProps<Value>) {
  const keys = useKeyGlyphs();
  const { rows } = useTerminalSize();
  const visibleCount =
    options.visibleCount ?? Math.max(3, Math.min(16, rows - 10));
  const searchable = options.searchable === true;
  const [query, setQuery] = useState("");
  const filtered = useMemo(
    () =>
      searchable
        ? filterChoices(options.options, query)
        : options.options.map((choice, index) => ({ choice, index })),
    [options.options, searchable, query],
  );
  const listRows = useMemo(() => {
    const result: Array<
      | {
          readonly type: "group";
          readonly label: string;
          readonly indices: number[];
        }
      | {
          readonly type: "choice";
          readonly choice: (typeof filtered)[number]["choice"];
          readonly index: number;
          readonly nested: boolean;
        }
    > = [];
    // Each contiguous run of a group gets its own header owning exactly the
    // run's rows — a group split by ungrouped entries must not produce two
    // headers that both toggle the whole group.
    let currentGroup: string | undefined;
    let currentHeader: { indices: number[] } | undefined;
    for (const entry of filtered) {
      const group = entry.choice.group;
      if (group === undefined) {
        currentHeader = undefined;
      } else if (group !== currentGroup || currentHeader === undefined) {
        const header = {
          type: "group" as const,
          label: group,
          indices: [] as number[],
        };
        result.push(header);
        currentHeader = header;
      }
      currentGroup = group;
      if (group !== undefined && currentHeader !== undefined) {
        currentHeader.indices.push(entry.index);
      }
      result.push({
        type: "choice",
        choice: entry.choice,
        index: entry.index,
        nested: group !== undefined,
      });
    }
    return result;
  }, [filtered]);
  const [selected, setSelected] = useSelectedChoices(
    options.options,
    options.initialValues ?? [],
  );
  const [error, setError] = useState<string>();
  const disabled = useMemo(
    () =>
      listRows.map((row) =>
        row.type === "choice"
          ? row.choice.disabled !== undefined && row.choice.disabled !== false
          : row.indices.every((index) =>
              Boolean(options.options[index]?.disabled),
            ),
      ),
    [listRows, options.options],
  );
  const { cursor, handleKey } = useChoiceList({
    disabled,
    searchable,
    visibleCount,
    query,
    setQuery,
    onCancel: cancel,
  });
  useTerminalInput((input, key) => {
    if (key.ctrl && input === "a") {
      const enabledVisible = filtered.flatMap(({ choice, index }) =>
        choice.disabled !== undefined && choice.disabled !== false
          ? []
          : [index],
      );
      if (enabledVisible.length === 0) return;
      setSelected((current) => {
        const next = new Set(current);
        const allSelected = enabledVisible.every((index) => next.has(index));
        for (const index of enabledVisible) {
          if (allSelected) next.delete(index);
          else next.add(index);
        }
        return next;
      });
      setError(undefined);
    } else if (input === " " && !key.ctrl && !key.meta) {
      const row = listRows[cursor];
      if (row === undefined) return;
      const indices =
        row.type === "group"
          ? row.indices.filter((index) => !options.options[index]?.disabled)
          : row.choice.disabled
            ? []
            : [row.index];
      if (indices.length === 0) return;
      setSelected((current) => {
        const next = new Set(current);
        const allSelected = indices.every((index) => next.has(index));
        for (const index of indices) {
          if (allSelected) next.delete(index);
          else next.add(index);
        }
        return next;
      });
      setError(undefined);
    } else if (key.enter) {
      if (options.required && selected.size === 0) {
        setError("Select at least one option.");
        return;
      }
      const values = options.options.flatMap((choice, index) =>
        selected.has(index) ? [choice.value] : [],
      );
      const labels = options.options.flatMap((choice, index) =>
        selected.has(index) ? [choice.label] : [],
      );
      submit(
        values,
        <AnsweredPrompt
          message={options.message}
          answer={labels.length === 0 ? "none" : labels.join(", ")}
        />,
      );
    } else if (handleKey(input, key)) {
      setError(undefined);
    }
  });
  const visibleChoices = listRows.map((row) =>
    row.type === "group"
      ? {
          value: row,
          label: row.label,
          sticky: true,
          tone: "info" as const,
        }
      : {
          ...row.choice,
          value: row,
          group: undefined,
          indent: row.nested ? 2 : row.choice.indent,
        },
  );
  const visibleSelected = new Set(
    listRows.flatMap((row, visibleIndex) => {
      if (row.type !== "group") {
        return selected.has(row.index) ? [visibleIndex] : [];
      }
      // Match the toggle semantics: disabled children are excluded there, so
      // they must not keep a fully-toggled group from rendering as selected.
      const toggleable = row.indices.filter(
        (index) => !options.options[index]?.disabled,
      );
      return toggleable.length > 0 &&
        toggleable.every((index) => selected.has(index))
        ? [visibleIndex]
        : [];
    }),
  );
  return (
    <PromptFrame
      message={options.message}
      error={error}
      keys={[
        [keys.upDown, "navigate"],
        [keys.space, "toggle"],
        ["ctrl+a", "toggle all"],
        [keys.enter, "confirm"],
        [keys.escape, query === "" ? "cancel" : "clear filter"],
      ]}
    >
      <Box flexDirection="column">
        {searchable ? (
          <FilterLine
            query={query}
            annotation={
              query === ""
                ? `${selected.size} selected`
                : `${filtered.length} of ${options.options.length} · ${selected.size} selected`
            }
          />
        ) : (
          <Text tone="muted">{selected.size} selected</Text>
        )}
        <Menu<(typeof listRows)[number]>
          choices={visibleChoices}
          cursor={cursor}
          selected={visibleSelected}
          visibleCount={visibleCount}
          empty="No matching choices."
          descriptionPlacement={options.descriptionPlacement}
        />
      </Box>
    </PromptFrame>
  );
}

export const multiSelectScreen = <Value,>(
  options: MultiSelectOptions<Value>,
): Screen<ReadonlyArray<Value>> => ({
  name: "multiple selection",
  render: ({ submit, cancel }) => (
    <MultiSelectPrompt options={options} submit={submit} cancel={cancel} />
  ),
});

type CycleSelectPromptProps<State> = {
  readonly options: CycleSelectOptions<State>;
  readonly submit: (value: ReadonlyArray<State>, summary?: ReactNode) => void;
  readonly cancel: () => void;
};

function CycleSelectPrompt<State>({
  options,
  submit,
  cancel,
}: CycleSelectPromptProps<State>) {
  const keys = useKeyGlyphs();
  const { rows } = useTerminalSize();
  const visibleCount =
    options.visibleCount ?? Math.max(3, Math.min(16, rows - 8));
  const navigation = useCycleNavigation(
    options.options.map((choice) => choice.states.length),
  );
  const [unchanged, setUnchanged] = useState(false);
  useCancel(cancel);
  const last = Math.max(0, options.options.length - 1);
  const page = Math.max(1, visibleCount);
  useTerminalInput((input, key) => {
    const plain = !key.ctrl && !key.meta;
    if (key.up || (plain && input === "k")) navigation.move(-1);
    else if (key.down || (plain && input === "j")) navigation.move(1);
    else if (key.home) navigation.setCursor(0);
    else if (key.end) navigation.setCursor(last);
    else if (key.pageUp)
      navigation.setCursor(Math.max(0, navigation.cursor - page));
    else if (key.pageDown)
      navigation.setCursor(Math.min(last, navigation.cursor + page));
    else if ((plain && input === " ") || key.right) {
      navigation.cycle(1);
      setUnchanged(false);
    } else if (key.left) {
      navigation.cycle(-1);
      setUnchanged(false);
    } else if (key.enter) {
      if (
        options.requireChange &&
        navigation.indices.every((index) => index === 0)
      ) {
        setUnchanged(true);
        return;
      }
      const values = options.options.flatMap((choice, index) => {
        const state = choice.states[navigation.indices[index] ?? 0];
        return state === undefined ? [] : [state.value];
      });
      const changed = options.options.flatMap((choice, index) => {
        if ((navigation.indices[index] ?? 0) === 0) return [];
        const state = choice.states[navigation.indices[index] ?? 0];
        return state === undefined
          ? []
          : [`${choice.label}: ${state.label ?? "changed"}`];
      });
      submit(
        values,
        <AnsweredPrompt
          message={options.message}
          answer={changed.length === 0 ? "no changes" : changed.join(", ")}
        />,
      );
    }
  });
  return (
    <PromptFrame
      message={options.message}
      keys={[
        [keys.upDown, "navigate"],
        [keys.space, "change"],
        [keys.enter, options.requireChange ? "apply" : "confirm"],
        [keys.escape, options.requireChange ? "back" : "cancel"],
      ]}
    >
      <Box flexDirection="column">
        <CycleList
          choices={options.options}
          cursor={navigation.cursor}
          indices={navigation.indices}
          visibleCount={visibleCount}
        />
        {unchanged ? (
          <Alert variant="warning" title="No changes to apply">
            {options.unchangedMessage ??
              "Press Space to change a selection, or Esc to go back."}
          </Alert>
        ) : null}
      </Box>
    </PromptFrame>
  );
}

export const cycleSelectScreen = <State,>(
  options: CycleSelectOptions<State>,
): Screen<ReadonlyArray<State>> => ({
  name: "cycle selection",
  render: ({ submit, cancel }) => (
    <CycleSelectPrompt options={options} submit={submit} cancel={cancel} />
  ),
});

export const awaitExternalScreen = screen<AwaitExternalOptions, string>(
  "external authorization",
  ({ options, submit, cancel }) => (
    <ExternalWait {...options} onSubmit={submit} onCancel={cancel} />
  ),
);

type ConfirmPromptProps = {
  readonly options: ConfirmOptions;
  readonly submit: (value: boolean, summary?: ReactNode) => void;
  readonly cancel: () => void;
};

function ConfirmPrompt({ options, submit, cancel }: ConfirmPromptProps) {
  const keys = useKeyGlyphs();
  const complete = (answer: boolean) =>
    submit(
      answer,
      <AnsweredPrompt
        message={options.message}
        answer={
          answer
            ? (options.confirmLabel ?? "yes")
            : (options.cancelLabel ?? "no")
        }
      />,
    );
  const value = useConfirmKeys({
    // Default to "no": most CLI confirms gate destructive operations, so an
    // absent-minded Enter must never approve one. Benign convenience prompts
    // opt into default-yes with an explicit `initialValue: true`.
    initialValue: options.initialValue ?? false,
    onSubmit: complete,
    onCancel: cancel,
  });
  return (
    <PromptFrame
      message={options.message}
      keys={[
        [
          options.confirmLabel === undefined &&
          options.cancelLabel === undefined
            ? keys.yesNo
            : keys.leftRight,
          "choose",
        ],
        [keys.enter, "confirm"],
        [keys.escape, "cancel"],
      ]}
    >
      <ChoiceGroup
        value={value}
        choices={[
          { value: true, label: options.confirmLabel ?? "Yes" },
          { value: false, label: options.cancelLabel ?? "No" },
        ]}
      />
    </PromptFrame>
  );
}

export const confirmScreen = screen<ConfirmOptions, boolean>(
  "confirmation",
  ConfirmPrompt,
);
