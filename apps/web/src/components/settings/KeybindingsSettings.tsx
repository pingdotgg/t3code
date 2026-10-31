import { useEnvironmentScope } from "../../state/session";
import { useEnvironmentsWithScope, readEnvironmentScope } from "../../state/session";
import {
  ChevronDownIcon,
  CircleXIcon,
  EllipsisIcon,
  FileJsonIcon,
  MinusIcon,
  PlusIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { useLocation } from "@tanstack/react-router";
import { type KeyboardEvent, type ReactNode, useReducer, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  type KeybindingCommand,
  type KeybindingWhenNode,
  type ServerRemoveKeybindingInput,
  type ServerUpsertKeybindingInput,
} from "@t3tools/contracts";
import { mergeWithDefaultKeybindings } from "@t3tools/shared/keybindings";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { isElectron } from "../../env";
import { useOpenInPreferredEditor } from "../../editorPreferences";
import { formatShortcutLabel } from "../../keybindings";
import { cn } from "../../lib/utils";
import { serverEnvironment } from "../../state/server";
import { useSettingsScope } from "./SettingsScopeContext";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Kbd, KbdGroup } from "../ui/kbd";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Toggle } from "../ui/toggle";
import { toastManager } from "../ui/toast";
import {
  buildKeybindingRows,
  filterKeybindingRows,
  buildKeybindingCommandOptions,
  buildWhenVariableOptions,
  commandLabel,
  DEFAULT_WHEN_VARIABLE,
  isKnownWhenVariable,
  keybindingConflictLabels,
  keybindingFromKeyboardEvent,
  parseWhenExpressionDraft,
  type KeybindingCommandOption,
  type KeybindingRow,
  type WhenVariableOption,
  unknownWhenVariables,
  whenAstToExpression,
  whenNodeRemoveLabel,
} from "./KeybindingsSettings.logic";
import {
  SettingsNoMatches,
  SettingsPageContainer,
  SettingsSearchField,
  SettingsSearchTarget,
  SettingsSection,
  SettingsToolbar,
} from "./settingsLayout";
import { keybindingSearchAnchorId, searchableSetting } from "./settingsSearch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useAtomCommand } from "../../state/use-atom-command";

function KeybindingPill({ value }: { value: string }) {
  // A literal "+" key ends the value ("mod++") and splits into trailing empty strings,
  // read back as one "+" key the way parseKeybindingShortcut does.
  const tokens = value.split("+");
  const endsWithPlusKey = tokens.at(-1) === "";
  while (tokens.at(-1) === "") tokens.pop();
  if (endsWithPlusKey) tokens.push("+");
  // React keys stay unique when a part repeats.
  const seenParts = new Map<string, number>();
  const parts = tokens.map((part) => {
    const seen = seenParts.get(part) ?? 0;
    seenParts.set(part, seen + 1);
    return { part, key: seen === 0 ? part : `${part}-${seen}` };
  });
  return (
    <KbdGroup>
      {parts.map(({ part, key }) => (
        <Kbd key={key}>
          {part === "mod"
            ? navigator.platform.toLowerCase().includes("mac")
              ? "⌘"
              : "Ctrl"
            : part === "shift"
              ? "⇧"
              : part === "alt"
                ? navigator.platform.toLowerCase().includes("mac")
                  ? "⌥"
                  : "Alt"
                : part === "ctrl"
                  ? "⌃"
                  : part.length === 1
                    ? part.toUpperCase()
                    : part}
        </Kbd>
      ))}
    </KbdGroup>
  );
}

type BooleanOperator = "and" | "or";

function flattenWhenChildren(
  node: KeybindingWhenNode,
  operator: BooleanOperator,
): KeybindingWhenNode[] {
  if (node.type !== operator) return [node];
  return [
    ...flattenWhenChildren(node.left, operator),
    ...flattenWhenChildren(node.right, operator),
  ];
}

function buildWhenExpressionGroup(
  children: readonly KeybindingWhenNode[],
  operator: BooleanOperator,
): KeybindingWhenNode | undefined {
  const first = children[0];
  if (!first) return undefined;
  return children.slice(1).reduce<KeybindingWhenNode>(
    (left, right) => ({
      type: operator,
      left,
      right,
    }),
    first,
  );
}

function conditionParts(node: KeybindingWhenNode): { identifier: string; negated: boolean } | null {
  if (node.type === "identifier") return { identifier: node.name, negated: false };
  if (node.type === "not" && node.node.type === "identifier") {
    return { identifier: node.node.name, negated: true };
  }
  return null;
}

function setConditionIdentifier(node: KeybindingWhenNode, identifier: string): KeybindingWhenNode {
  const parts = conditionParts(node);
  if (!parts) return node;
  const next: KeybindingWhenNode = { type: "identifier", name: identifier };
  return parts.negated ? { type: "not", node: next } : next;
}

function setConditionNegated(node: KeybindingWhenNode, negated: boolean): KeybindingWhenNode {
  const parts = conditionParts(node);
  if (!parts) return negated ? { type: "not", node } : node;
  const identifier: KeybindingWhenNode = { type: "identifier", name: parts.identifier };
  return negated ? { type: "not", node: identifier } : identifier;
}

function defaultWhenCondition(): KeybindingWhenNode {
  return { type: "identifier", name: DEFAULT_WHEN_VARIABLE };
}

function defaultWhenGroup(operator: BooleanOperator = "and"): KeybindingWhenNode {
  return {
    type: operator,
    left: defaultWhenCondition(),
    right: { type: "not", node: defaultWhenCondition() },
  };
}

function WarningTooltipIcon({
  label,
  focusable = true,
  className,
  children,
}: {
  label: string;
  focusable?: boolean;
  className?: string | undefined;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={focusable ? 0 : undefined}
            aria-label={label}
            className={cn(
              "inline-flex size-5 shrink-0 items-center justify-center rounded-kbd text-warning-foreground outline-none transition-colors hover:bg-warning/10 focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-warning/25",
              className,
            )}
          />
        }
      >
        <TriangleAlertIcon className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">{children}</TooltipPopup>
    </Tooltip>
  );
}

function UnknownWhenVariableWarning({
  identifiers,
  focusable = true,
}: {
  identifiers: ReadonlyArray<string>;
  focusable?: boolean;
}) {
  if (identifiers.length === 0) return null;
  const label =
    identifiers.length === 1
      ? `Unknown condition: ${identifiers[0]}`
      : `Unknown conditions: ${identifiers.join(", ")}`;

  return (
    <WarningTooltipIcon label={label} focusable={focusable} className="size-4.5">
      T3 Code does not recognize this condition yet. It can still be saved, but it may not match
      unless the runtime provides it.
    </WarningTooltipIcon>
  );
}

function KeybindingConflictWarning({ labels }: { labels: ReadonlyArray<string> }) {
  if (labels.length === 0) return null;
  const description =
    labels.length === 1
      ? `Conflicts with ${labels[0]}.`
      : `Conflicts with ${labels.slice(0, 3).join(", ")}${labels.length > 3 ? ", and more" : ""}.`;

  return (
    <WarningTooltipIcon label={description}>
      {description} The most recent matching binding wins when both conditions can apply.
    </WarningTooltipIcon>
  );
}

function WhenVariableSelect({
  value,
  variables,
  unknownIdentifiers,
  onChange,
}: {
  value: string;
  variables: ReadonlyArray<WhenVariableOption>;
  unknownIdentifiers?: ReadonlyArray<string>;
  onChange: (value: string) => void;
}) {
  const selected = variables.find((option) => option === value);
  const options =
    selected || variables.some((option) => option === value) ? variables : [value, ...variables];

  return (
    <Select value={value} onValueChange={(nextValue) => nextValue && onChange(nextValue)}>
      <SelectTrigger size="compact" className="min-w-0 flex-1">
        <SelectValue placeholder="Condition" />
        {unknownIdentifiers && unknownIdentifiers.length > 0 ? (
          <UnknownWhenVariableWarning identifiers={unknownIdentifiers} focusable={false} />
        ) : null}
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false} matchTriggerWidth={false} className="max-h-72">
        {options.map((option) => (
          <SelectItem key={option} value={option} className="w-full">
            <span className="truncate">{option}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function WhenExpressionRemoveButton({
  label,
  className,
  onRemove,
}: {
  label: string;
  className?: string | undefined;
  onRemove: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        delay={200}
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className={cn("size-7", className)}
            aria-label={label}
            onClick={onRemove}
          />
        }
      >
        <MinusIcon aria-hidden className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

function WhenExpressionNodeEditor({
  node,
  variables,
  depth = 0,
  onChange,
  onRemove,
}: {
  node: KeybindingWhenNode;
  variables: ReadonlyArray<WhenVariableOption>;
  depth?: number;
  onChange: (node: KeybindingWhenNode) => void;
  onRemove?: () => void;
}) {
  const condition = conditionParts(node);

  if (condition) {
    const unknownIdentifiers = isKnownWhenVariable(condition.identifier)
      ? []
      : [condition.identifier];

    return (
      <div className="flex items-center gap-2 rounded-row surface-well px-2 py-2">
        <Toggle
          pressed={condition.negated}
          onPressedChange={(pressed) => onChange(setConditionNegated(node, pressed))}
          aria-label={`Negate ${condition.identifier}`}
          variant="outline"
          size="compact"
          className="min-w-10"
        >
          Not
        </Toggle>
        <WhenVariableSelect
          value={condition.identifier}
          variables={variables}
          unknownIdentifiers={unknownIdentifiers}
          onChange={(value) => onChange(setConditionIdentifier(node, value))}
        />
        {onRemove ? (
          <WhenExpressionRemoveButton
            label={whenNodeRemoveLabel(node, depth)}
            onRemove={onRemove}
          />
        ) : null}
      </div>
    );
  }

  if (node.type === "not") {
    return (
      <div
        className={cn(
          "space-y-2 rounded-control border border-border/50 surface-card-settings p-2",
          depth > 0 && "surface-well",
        )}
      >
        <div className="flex items-center gap-2">
          <Toggle
            pressed
            onPressedChange={(pressed) => onChange(pressed ? node : node.node)}
            aria-label="Negate group"
            variant="outline"
            size="compact"
            className="min-w-10"
          >
            Not
          </Toggle>
          {onRemove ? (
            <WhenExpressionRemoveButton
              label={whenNodeRemoveLabel(node, depth)}
              className="ml-auto"
              onRemove={onRemove}
            />
          ) : null}
        </div>
        <div className="relative pl-4">
          <span className="absolute top-0 bottom-0 left-1.5 w-px bg-border/70" aria-hidden />
          <span className="absolute top-4 left-1.5 h-px w-2.5 bg-border/70" aria-hidden />
          <WhenExpressionNodeEditor
            node={node.node}
            variables={variables}
            depth={depth + 1}
            onChange={(next) => onChange({ type: "not", node: next })}
          />
        </div>
      </div>
    );
  }

  const operator: BooleanOperator = node.type === "or" ? "or" : "and";
  const children = flattenWhenChildren(node, operator);
  const childKeyCounts = new Map<string, number>();
  const childEntries = children.map((child) => {
    const baseKey = `${child.type}-${whenAstToExpression(child)}`;
    const count = childKeyCounts.get(baseKey) ?? 0;
    childKeyCounts.set(baseKey, count + 1);
    return { child, key: count === 0 ? baseKey : `${baseKey}-${count}` };
  });

  const updateChild = (target: KeybindingWhenNode, next: KeybindingWhenNode) => {
    let didUpdate = false;
    const nextChildren = children.map((child) => {
      if (!didUpdate && child === target) {
        didUpdate = true;
        return next;
      }
      return child;
    });
    const nextNode = buildWhenExpressionGroup(nextChildren, operator);
    if (nextNode) onChange(nextNode);
  };

  const removeChild = (target: KeybindingWhenNode) => {
    let didRemove = false;
    const nextChildren = children.filter((child) => {
      if (!didRemove && child === target) {
        didRemove = true;
        return false;
      }
      return true;
    });
    const nextNode = buildWhenExpressionGroup(nextChildren, operator);
    if (nextNode) {
      onChange(nextNode);
    } else {
      onChange(defaultWhenCondition());
    }
  };

  const setOperator = (nextOperator: BooleanOperator) => {
    if (nextOperator === operator) return;
    const nextNode = buildWhenExpressionGroup(children, nextOperator);
    if (nextNode) onChange(nextNode);
  };

  const addCondition = () => {
    const nextNode = buildWhenExpressionGroup([...children, defaultWhenCondition()], operator);
    if (nextNode) onChange(nextNode);
  };

  const addGroup = () => {
    const nestedOperator: BooleanOperator = operator === "and" ? "or" : "and";
    const group: KeybindingWhenNode = {
      type: nestedOperator,
      left: defaultWhenCondition(),
      right: { type: "not", node: defaultWhenCondition() },
    };
    const nextNode = buildWhenExpressionGroup([...children, group], operator);
    if (nextNode) onChange(nextNode);
  };

  return (
    <div
      className={cn(
        "space-y-2 rounded-control border border-border/50 surface-card-settings p-2",
        depth > 0 && "surface-well",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Select value={operator} onValueChange={(value) => setOperator(value as BooleanOperator)}>
          <SelectTrigger size="compact" className="w-24">
            <SelectValue />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false} matchTriggerWidth={false}>
            <SelectItem value="and">and</SelectItem>
            <SelectItem value="or">or</SelectItem>
          </SelectContent>
        </Select>
        <Button type="button" variant="secondary" size="compact" onClick={addCondition}>
          <PlusIcon className="size-3.5" />
          Condition
        </Button>
        <Button type="button" variant="secondary" size="compact" onClick={addGroup}>
          <PlusIcon className="size-3.5" />
          Group
        </Button>
        {onRemove ? (
          <WhenExpressionRemoveButton
            label={whenNodeRemoveLabel(node, depth)}
            className="ml-auto"
            onRemove={onRemove}
          />
        ) : null}
      </div>
      <div className="space-y-2">
        {childEntries.map(({ child, key }) => (
          <div key={key} className="relative pl-4">
            <span
              className={cn(
                "absolute top-0 bottom-0 left-1.5 w-px",
                depth === 0 ? "bg-border" : "bg-border/70",
              )}
              aria-hidden
            />
            <span
              className={cn(
                "absolute top-4 left-1.5 h-px w-2.5",
                depth === 0 ? "bg-border" : "bg-border/70",
              )}
              aria-hidden
            />
            <WhenExpressionNodeEditor
              node={child}
              variables={variables}
              depth={depth + 1}
              onChange={(next) => updateChild(child, next)}
              onRemove={() => removeChild(child)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function WhenExpressionBuilder({
  value,
  variables,
  onChange,
  onValidityChange,
}: {
  value: KeybindingWhenNode | undefined;
  variables: ReadonlyArray<WhenVariableOption>;
  onChange: (value: KeybindingWhenNode | undefined) => void;
  onValidityChange?: (valid: boolean) => void;
}) {
  const expression = whenAstToExpression(value);
  const [expressionDraft, setExpressionDraft] = useState(expression);
  const parseResult = parseWhenExpressionDraft(expressionDraft);
  const parseError = parseResult.ok ? null : parseResult.message;
  const unknownIdentifiers = parseResult.ok ? unknownWhenVariables(parseResult.value) : [];

  const updateExpressionDraft = (nextExpression: string) => {
    setExpressionDraft(nextExpression);
    const nextResult = parseWhenExpressionDraft(nextExpression);
    onValidityChange?.(nextResult.ok);
    if (nextResult.ok) {
      onChange(nextResult.value);
    }
  };

  const updateExpressionValue = (nextValue: KeybindingWhenNode | undefined) => {
    setExpressionDraft(whenAstToExpression(nextValue));
    onValidityChange?.(true);
    onChange(nextValue);
  };

  const addRootCondition = () => {
    if (!value) {
      updateExpressionValue(defaultWhenCondition());
      return;
    }
    updateExpressionValue({ type: "and", left: value, right: defaultWhenCondition() });
  };

  const addRootGroup = () => {
    const group = defaultWhenGroup("or");
    if (!value) {
      updateExpressionValue(group);
      return;
    }
    updateExpressionValue({ type: "and", left: value, right: group });
  };

  return (
    <div className="w-[min(34rem,calc(100vw-2rem))] space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-label text-strong-foreground">When</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button type="button" variant="secondary" size="compact" onClick={addRootCondition}>
            <PlusIcon className="size-3.5" />
            Condition
          </Button>
          <Button type="button" variant="secondary" size="compact" onClick={addRootGroup}>
            <PlusIcon className="size-3.5" />
            Group
          </Button>
        </div>
      </div>

      <div className="space-y-1.5">
        <InputGroup>
          <InputGroupInput
            value={expressionDraft}
            onChange={(event) => updateExpressionDraft(event.currentTarget.value)}
            placeholder="Always"
            aria-invalid={Boolean(parseError)}
            aria-label="When expression"
            size="compact"
            font="mono"
          />
          {unknownIdentifiers.length > 0 ? (
            <InputGroupAddon align="inline-end">
              <UnknownWhenVariableWarning identifiers={unknownIdentifiers} />
            </InputGroupAddon>
          ) : null}
        </InputGroup>
        {parseError ? (
          <div className="flex items-center gap-1.5 text-caption text-destructive">
            <CircleXIcon className="size-3.5" />
            {parseError}
          </div>
        ) : null}
      </div>

      <div className="relative">
        {value ? (
          <WhenExpressionNodeEditor
            node={value}
            variables={variables}
            onChange={updateExpressionValue}
            onRemove={() => updateExpressionValue(undefined)}
          />
        ) : (
          <div className="rounded-row border border-dashed border-border/50 surface-card-settings p-3">
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="compact" onClick={addRootCondition}>
                <PlusIcon className="size-3.5" />
                Condition
              </Button>
              <Button type="button" variant="secondary" size="compact" onClick={addRootGroup}>
                <PlusIcon className="size-3.5" />
                Group
              </Button>
            </div>
          </div>
        )}
        {parseError ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg border border-destructive/30 bg-popover p-4 text-center text-meta text-destructive">
            Fix the expression above to continue editing visually.
          </div>
        ) : null}
      </div>
    </div>
  );
}

type KeybindingRowDraftState = {
  keyDraft: string;
  whenDraft: KeybindingWhenNode | undefined;
  isRecording: boolean;
  isWhenDraftValid: boolean;
};

function createKeybindingRowDraft(row: KeybindingRow): KeybindingRowDraftState {
  return {
    keyDraft: row.key,
    whenDraft: row.binding.whenAst,
    isRecording: false,
    isWhenDraftValid: true,
  };
}

function keybindingRowDraftReducer(
  state: KeybindingRowDraftState,
  patch: Partial<KeybindingRowDraftState>,
): KeybindingRowDraftState {
  return { ...state, ...patch };
}

function rowKeybindingTarget(row: KeybindingRow): ServerRemoveKeybindingInput {
  return {
    command: row.command,
    key: row.key,
    ...(row.when.trim().length > 0 ? { when: row.when } : {}),
  };
}

function useKeybindingRowEditor({
  row,
  allRows,
  onSave,
  initialRecording = false,
}: {
  row: KeybindingRow;
  allRows: ReadonlyArray<KeybindingRow>;
  onSave: (input: ServerUpsertKeybindingInput) => void;
  initialRecording?: boolean;
}) {
  const [draft, setDraft] = useReducer(keybindingRowDraftReducer, {
    ...createKeybindingRowDraft(row),
    isRecording: initialRecording,
  });
  const pillRef = useRef<HTMLButtonElement>(null);
  const { keyDraft, whenDraft, isRecording, isWhenDraftValid } = draft;
  const whenDraftExpression = whenAstToExpression(whenDraft);
  const isDirty = keyDraft !== row.key || whenDraftExpression !== row.when;
  const conflictLabels = keybindingConflictLabels(allRows, {
    rowId: row.id,
    key: keyDraft,
    when: whenDraftExpression,
  });

  const save = () => {
    onSave({
      command: row.command,
      key: keyDraft,
      when: whenDraftExpression.trim().length > 0 ? whenDraftExpression : undefined,
      replace: rowKeybindingTarget(row),
    });
  };

  const captureKeybinding = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Tab" && !isRecording) return;
    event.preventDefault();
    if (event.key === "Escape") {
      // An unhandled Escape closes the settings page.
      event.stopPropagation();
      const field = event.currentTarget;
      flushSync(() => setDraft({ keyDraft: row.key, isRecording: false }));
      // The field may unmount for the pill; focus would otherwise drop to the page.
      if (pillRef.current) pillRef.current.focus();
      else field.blur();
      return;
    }
    const next = keybindingFromKeyboardEvent(event.nativeEvent, navigator.platform, {
      layoutCharacter: true,
    });
    if (!next) return;
    setDraft({ keyDraft: next, isRecording: false });
  };

  return {
    keyDraft,
    whenDraft,
    isRecording,
    isWhenDraftValid,
    whenDraftExpression,
    isDirty,
    conflictLabels,
    setDraft,
    save,
    captureKeybinding,
    pillRef,
  };
}

type KeybindingRowEditor = ReturnType<typeof useKeybindingRowEditor>;

interface KeybindingRowActions {
  allRows: ReadonlyArray<KeybindingRow>;
  variables: ReadonlyArray<WhenVariableOption>;
  onSave: (input: ServerUpsertKeybindingInput) => void;
  onReset: (row: KeybindingRow) => void;
  onRemove: (row: KeybindingRow) => void;
}

type KeybindingRowProps = KeybindingRowActions & {
  row: KeybindingRow;
  isSaving: boolean;
  anchorId?: string | undefined;
};

/** Shortcut pill that turns into a capture input when clicked. */
function KeybindingKeyControl({
  row,
  editor,
}: {
  row: KeybindingRow;
  editor: KeybindingRowEditor;
}) {
  const { keyDraft, isRecording, isDirty, setDraft, captureKeybinding, pillRef } = editor;
  const showPill = !isRecording && keyDraft === row.key && row.key.length > 0 && !isDirty;

  return showPill ? (
    <button
      ref={pillRef}
      type="button"
      onClick={() => setDraft({ isRecording: true })}
      aria-label={`Edit shortcut for ${commandLabel(row.command)}: ${formatShortcutLabel(row.binding.shortcut)}`}
      className="-ml-1.5 inline-flex h-7 max-w-full cursor-pointer items-center rounded-md border border-transparent px-1.5 outline-none transition-colors hover:border-border/70 hover:surface-ghost-hover focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/24"
    >
      <KeybindingPill value={row.key} />
    </button>
  ) : (
    <Input
      data-keybinding-capture=""
      autoFocus={isRecording}
      aria-label={`Keybinding for ${commandLabel(row.command)}`}
      value={isRecording ? "" : keyDraft}
      placeholder={isRecording ? "Press shortcut" : "Unassigned"}
      size="sm"
      font="mono"
      onFocus={() => setDraft({ isRecording: true })}
      onBlur={() => setDraft({ isRecording: false })}
      onChange={(event) => setDraft({ keyDraft: event.currentTarget.value })}
      onKeyDown={captureKeybinding}
    />
  );
}

function WhenClauseControl({
  label,
  expression,
  value,
  variables,
  onChange,
  onValidityChange,
  defaultOpen = false,
}: {
  label: string;
  expression: string;
  value: KeybindingWhenNode | undefined;
  variables: ReadonlyArray<WhenVariableOption>;
  onChange: (value: KeybindingWhenNode | undefined) => void;
  onValidityChange: (valid: boolean) => void;
  defaultOpen?: boolean;
}) {
  // Closing unmounts the builder, which drops an unparsed draft and keeps the last valid value.
  const handleOpenChange = (open: boolean) => {
    if (!open) onValidityChange(true);
  };

  return (
    <Popover defaultOpen={defaultOpen} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        render={
          <Button
            variant={expression ? "ghost" : "ghost-muted"}
            size="micro"
            className="min-w-0 shrink"
          />
        }
        aria-label={`Edit when clause for ${label}`}
      >
        <span
          className={cn(
            "truncate font-mono font-normal",
            expression ? "text-muted-foreground" : "text-dim-foreground",
          )}
        >
          {expression || "Always"}
        </span>
        <ChevronDownIcon className="size-3.5 shrink-0 opacity-0 transition-opacity group-focus-within/row:opacity-60 group-hover/row:opacity-60 pointer-coarse:opacity-60" />
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6}>
        <WhenExpressionBuilder
          value={value}
          variables={variables}
          onChange={onChange}
          onValidityChange={onValidityChange}
        />
      </PopoverContent>
    </Popover>
  );
}

function KeybindingRowMenu({
  row,
  isSaving,
  onReset,
  onRemove,
}: {
  row: KeybindingRow;
  isSaving: boolean;
  onReset: (row: KeybindingRow) => void;
  onRemove: (row: KeybindingRow) => void;
}) {
  const canReset = row.source === "Custom" && row.defaultKey !== null;
  const canRemove = row.source !== "Default";
  if (!canReset && !canRemove) return null;

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            type="button"
            variant="ghost-muted"
            size="icon-sm"
            disabled={isSaving}
            aria-label={`Actions for ${commandLabel(row.command)}`}
          />
        }
      >
        <EllipsisIcon className="size-3.5" />
      </MenuTrigger>
      <MenuPopup align="end">
        {canReset ? (
          <MenuItem disabled={isSaving} onClick={() => onReset(row)}>
            Reset to default
          </MenuItem>
        ) : null}
        {canRemove ? (
          <MenuItem variant="destructive" disabled={isSaving} onClick={() => onRemove(row)}>
            Remove
          </MenuItem>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

function KeybindingSourceBadge({ source }: { source: KeybindingRow["source"] }) {
  if (source === "Default") return null;
  return (
    <Badge variant="secondary" size="sm">
      {source}
    </Badge>
  );
}

function KeybindingRowTitle({ row }: { row: KeybindingRow }) {
  return (
    <TooltipTrigger
      payload={row.command}
      render={<span className="flex min-w-0 items-center gap-2 text-body text-foreground" />}
    >
      <span className="truncate">{commandLabel(row.command)}</span>
      <KeybindingSourceBadge source={row.source} />
    </TooltipTrigger>
  );
}

function KeybindingHoverRowMenu(props: {
  row: KeybindingRow;
  isSaving: boolean;
  onReset: (row: KeybindingRow) => void;
  onRemove: (row: KeybindingRow) => void;
}) {
  return (
    <span className="flex items-center opacity-0 transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100 has-data-popup-open:opacity-100 pointer-coarse:opacity-100">
      <KeybindingRowMenu {...props} />
    </span>
  );
}

/**
 * Fixed subgrid tracks prevent column shifts while editing. Extra row actions share the tail;
 * narrow containers move Command above Keys and When and hide the header visually.
 */
const KEYBINDING_TABLE_GRID =
  "grid grid-cols-[minmax(0,1fr)_150px_140px] items-center gap-x-4 @max-lg/keybindings:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]";
const KEYBINDING_TABLE_ROW = "col-span-full grid grid-cols-subgrid items-center gap-y-1 px-4";
const KEYBINDING_TABLE_COMMAND = "min-w-0 @max-lg/keybindings:col-span-full";
const KEYBINDING_TABLE_TAIL = "flex min-w-0 items-center gap-1";

function KeybindingTableHead() {
  return (
    <div
      role="row"
      className={cn(
        KEYBINDING_TABLE_ROW,
        "py-2 text-meta text-dim-foreground @max-lg/keybindings:sr-only",
      )}
    >
      <span role="columnheader">Command</span>
      <span role="columnheader">Keys</span>
      <span role="columnheader">When</span>
    </div>
  );
}

/** Resting rows need only two triggers; mount capture and condition editors on demand. */
function KeybindingSettingsRow(props: KeybindingRowProps) {
  const [editing, setEditing] = useState<"shortcut" | "when" | null>(null);
  if (editing) return <EditableKeybindingSettingsRow {...props} initialEditor={editing} />;
  const { row, anchorId, allRows, isSaving, onReset, onRemove } = props;
  return (
    <SettingsSearchTarget
      id={anchorId}
      role="row"
      style={{ contentVisibility: "auto", containIntrinsicSize: "auto 38px" }}
      className={cn(KEYBINDING_TABLE_ROW, "group/row min-h-9.5 py-1 outline-none")}
    >
      <span role="cell" className={KEYBINDING_TABLE_COMMAND}>
        <KeybindingRowTitle row={row} />
      </span>
      <span role="cell" className="-ml-1.5 flex min-w-0 items-center">
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Edit shortcut for ${commandLabel(row.command)}: ${formatShortcutLabel(row.binding.shortcut)}`}
          onClick={() => setEditing("shortcut")}
        >
          {row.key ? <KeybindingPill value={row.key} /> : "Unassigned"}
        </Button>
      </span>
      <div role="presentation" className={KEYBINDING_TABLE_TAIL}>
        <span role="cell" className="-ml-1.5 flex min-w-0 flex-1 items-center">
          <Button
            variant={row.when ? "ghost" : "ghost-muted"}
            size="micro"
            className="min-w-0 shrink"
            aria-label={`Edit when clause for ${commandLabel(row.command)}`}
            onClick={() => setEditing("when")}
          >
            <span className="truncate font-mono text-meta">{row.when || "Always"}</span>
            <ChevronDownIcon className="size-3.5 shrink-0 opacity-0 group-focus-within/row:opacity-60 group-hover/row:opacity-60 pointer-coarse:opacity-60" />
          </Button>
        </span>
        <span role="cell" className="flex shrink-0 items-center gap-1">
          <KeybindingConflictWarning
            labels={keybindingConflictLabels(allRows, {
              rowId: row.id,
              key: row.key,
              when: row.when,
            })}
          />
          <KeybindingHoverRowMenu
            row={row}
            isSaving={isSaving}
            onReset={onReset}
            onRemove={onRemove}
          />
        </span>
      </div>
    </SettingsSearchTarget>
  );
}

function EditableKeybindingSettingsRow(
  props: KeybindingRowProps & { initialEditor: "shortcut" | "when" },
) {
  const { row, isSaving, anchorId, allRows, variables, onSave, onReset, onRemove } = props;
  const editor = useKeybindingRowEditor({
    row,
    allRows,
    onSave,
    initialRecording: props.initialEditor === "shortcut",
  });

  return (
    <SettingsSearchTarget
      id={anchorId}
      role="row"
      style={{ contentVisibility: "auto", containIntrinsicSize: "auto 38px" }}
      className={cn(KEYBINDING_TABLE_ROW, "group/row min-h-9.5 py-1 outline-none")}
    >
      <span role="cell" className={KEYBINDING_TABLE_COMMAND}>
        <KeybindingRowTitle row={row} />
      </span>
      <span role="cell" className="flex min-w-0 items-center">
        <KeybindingKeyControl row={row} editor={editor} />
      </span>
      <div role="presentation" className={KEYBINDING_TABLE_TAIL}>
        <span role="cell" className="-ml-1.5 flex min-w-0 flex-1 items-center">
          <WhenClauseControl
            defaultOpen={props.initialEditor === "when"}
            label={commandLabel(row.command)}
            expression={editor.whenDraftExpression}
            value={editor.whenDraft}
            variables={variables}
            onChange={(whenDraft) => editor.setDraft({ whenDraft })}
            onValidityChange={(isWhenDraftValid) => editor.setDraft({ isWhenDraftValid })}
          />
        </span>
        <span role="cell" className="flex shrink-0 items-center gap-1">
          <KeybindingConflictWarning labels={editor.conflictLabels} />
          {editor.isDirty ? (
            <Button
              size="xs"
              disabled={isSaving || editor.keyDraft.trim().length === 0 || !editor.isWhenDraftValid}
              onClick={editor.save}
            >
              {isSaving ? "Saving" : "Save"}
            </Button>
          ) : null}
          <KeybindingHoverRowMenu
            row={row}
            isSaving={isSaving}
            onReset={onReset}
            onRemove={onRemove}
          />
        </span>
      </div>
    </SettingsSearchTarget>
  );
}

function useNewKeybindingDraft({
  allRows,
  onSave,
}: {
  allRows: ReadonlyArray<KeybindingRow>;
  onSave: (input: ServerUpsertKeybindingInput) => void;
}) {
  const [commandDraft, setCommandDraft] = useState<KeybindingCommand | "">("");
  const [draft, setDraft] = useReducer(keybindingRowDraftReducer, {
    keyDraft: "",
    whenDraft: undefined,
    isRecording: false,
    isWhenDraftValid: true,
  });
  const { keyDraft, whenDraft, isRecording, isWhenDraftValid } = draft;
  const whenDraftExpression = whenAstToExpression(whenDraft);
  const conflictLabels = keybindingConflictLabels(allRows, {
    rowId: "new",
    key: keyDraft,
    when: whenDraftExpression,
  });
  const commandLabelText = commandDraft ? commandLabel(commandDraft) : "new keybinding";
  const canSave = Boolean(commandDraft) && keyDraft.trim().length > 0 && isWhenDraftValid;

  const save = () => {
    if (!commandDraft) return;
    onSave({
      command: commandDraft,
      key: keyDraft,
      ...(whenDraftExpression.trim().length > 0 ? { when: whenDraftExpression } : {}),
    });
  };

  const captureKeybinding = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Tab" && !isRecording) return;
    event.preventDefault();
    if (event.key === "Escape") {
      // An unhandled Escape closes the settings page.
      event.stopPropagation();
      setDraft({ keyDraft: "", isRecording: false });
      event.currentTarget.blur();
      return;
    }
    const next = keybindingFromKeyboardEvent(event.nativeEvent, navigator.platform, {
      layoutCharacter: true,
    });
    if (!next) return;
    setDraft({ keyDraft: next, isRecording: false });
  };

  return {
    commandDraft,
    setCommandDraft,
    keyDraft,
    whenDraft,
    whenDraftExpression,
    isRecording,
    conflictLabels,
    commandLabelText,
    canSave,
    setDraft,
    save,
    captureKeybinding,
  };
}

type NewKeybindingDraft = ReturnType<typeof useNewKeybindingDraft>;

interface NewKeybindingProps {
  commandOptions: ReadonlyArray<KeybindingCommandOption>;
  allRows: ReadonlyArray<KeybindingRow>;
  variables: ReadonlyArray<WhenVariableOption>;
  isSaving: boolean;
  onSave: (input: ServerUpsertKeybindingInput) => void;
  onCancel: () => void;
}

function NewKeybindingCommandSelect({
  draft,
  commandOptions,
  className,
}: {
  draft: NewKeybindingDraft;
  commandOptions: ReadonlyArray<KeybindingCommandOption>;
  className?: string | undefined;
}) {
  return (
    <Select
      value={draft.commandDraft}
      onValueChange={(value) => draft.setCommandDraft(value as KeybindingCommand)}
    >
      {/* The row opens from "Add keybinding", which it disables, so it takes the focus. */}
      <SelectTrigger size="sm" autoFocus className={className}>
        <SelectValue placeholder="Command" />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false} matchTriggerWidth={false} className="max-h-72">
        {commandOptions.map((command) => (
          <SelectItem key={command} value={command} className="w-full">
            <span className="truncate">{commandLabel(command)}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function NewKeybindingKeyInput({
  draft,
  autoFocus = false,
  className,
}: {
  draft: NewKeybindingDraft;
  autoFocus?: boolean;
  className?: string | undefined;
}) {
  return (
    <Input
      data-keybinding-capture=""
      autoFocus={autoFocus}
      aria-label={`Keybinding for ${draft.commandLabelText}`}
      value={draft.isRecording ? "" : draft.keyDraft}
      placeholder={draft.isRecording ? "Press shortcut" : "Unassigned"}
      size="sm"
      font="mono"
      className={className}
      onFocus={() => draft.setDraft({ isRecording: true })}
      onBlur={() => draft.setDraft({ isRecording: false })}
      onChange={(event) => draft.setDraft({ keyDraft: event.currentTarget.value })}
      onKeyDown={draft.captureKeybinding}
    />
  );
}

function NewKeybindingWhen({
  draft,
  variables,
}: {
  draft: NewKeybindingDraft;
  variables: ReadonlyArray<WhenVariableOption>;
}) {
  return (
    <WhenClauseControl
      label={draft.commandLabelText}
      expression={draft.whenDraftExpression}
      value={draft.whenDraft}
      variables={variables}
      onChange={(whenDraft) => draft.setDraft({ whenDraft })}
      onValidityChange={(isWhenDraftValid) => draft.setDraft({ isWhenDraftValid })}
    />
  );
}

function NewKeybindingCancelIcon({
  isSaving,
  onCancel,
}: {
  isSaving: boolean;
  onCancel: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost-muted"
            size="icon-sm"
            disabled={isSaving}
            aria-label="Cancel new keybinding"
            onClick={onCancel}
          />
        }
      >
        <XIcon className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">Cancel</TooltipPopup>
    </Tooltip>
  );
}

/** Add-binding form shaped like the table rows below it. */
function NewKeybindingSettingsRow(props: NewKeybindingProps) {
  const { commandOptions, allRows, variables, isSaving, onSave, onCancel } = props;
  const draft = useNewKeybindingDraft({ allRows, onSave });

  return (
    <div
      role="row"
      className={cn(KEYBINDING_TABLE_ROW, "group/row py-2 surface-selected-soft")}
      // Escape cancels the row before the page's Escape leaves Settings. Its
      // controls keep their own Escape (closing a picker, clearing the key).
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented || isSaving) return;
        event.preventDefault();
        onCancel();
      }}
    >
      <span role="cell" className={KEYBINDING_TABLE_COMMAND}>
        <NewKeybindingCommandSelect
          draft={draft}
          commandOptions={commandOptions}
          className="w-full"
        />
      </span>
      <span role="cell" className="min-w-0">
        <NewKeybindingKeyInput draft={draft} />
      </span>
      <div role="presentation" className={KEYBINDING_TABLE_TAIL}>
        <span role="cell" className="-ml-1.5 flex min-w-0 flex-1 items-center">
          <NewKeybindingWhen draft={draft} variables={variables} />
        </span>
        <span role="cell" className="flex shrink-0 items-center gap-1">
          <KeybindingConflictWarning labels={draft.conflictLabels} />
          <Button size="xs" disabled={isSaving || !draft.canSave} onClick={draft.save}>
            {isSaving ? "Saving" : "Save"}
          </Button>
          <NewKeybindingCancelIcon isSaving={isSaving} onCancel={onCancel} />
        </span>
      </div>
    </div>
  );
}

interface KeybindingsListProps extends KeybindingRowActions {
  rows: ReadonlyArray<KeybindingRow>;
  commandOptions: ReadonlyArray<KeybindingCommandOption>;
  savingCommand: KeybindingCommand | null;
  isAddingBinding: boolean;
  onCancelAdd: () => void;
  query: string;
  onClearQuery: () => void;
}

/** The add-binding row, one settings row per binding, and the empty state. */
function KeybindingsList(props: KeybindingsListProps) {
  const {
    rows,
    commandOptions,
    savingCommand,
    isAddingBinding,
    onCancelAdd,
    query,
    onClearQuery,
    ...rowActions
  } = props;
  const newProps: NewKeybindingProps = {
    commandOptions,
    allRows: rowActions.allRows,
    variables: rowActions.variables,
    isSaving: savingCommand !== null,
    onSave: rowActions.onSave,
    onCancel: onCancelAdd,
  };
  const anchorIds = keybindingAnchorIds(rows);
  return (
    <Tooltip<KeybindingCommand>>
      {({ payload }) => (
        <>
          <div
            role="table"
            aria-label="Shortcuts"
            className={cn(
              KEYBINDING_TABLE_GRID,
              "[&>*+*]:border-t [&>*+*]:border-divider dark:[&>*+*]:border-divider/60",
            )}
          >
            <KeybindingTableHead />
            {isAddingBinding ? <NewKeybindingSettingsRow {...newProps} /> : null}
            {rows.map((row) => (
              <KeybindingSettingsRow
                key={row.id}
                row={row}
                anchorId={anchorIds.get(row.id)}
                isSaving={savingCommand === row.command}
                {...rowActions}
              />
            ))}
            {rows.length === 0 && !isAddingBinding ? (
              <div className="col-span-full">
                <SettingsNoMatches onClear={onClearQuery}>
                  No keybindings match “{query.trim()}”.
                </SettingsNoMatches>
              </div>
            ) : null}
          </div>
          <TooltipPopup side="top">{payload}</TooltipPopup>
        </>
      )}
    </Tooltip>
  );
}

const BROWSER_KEYBINDING_WARNING =
  "Some shortcuts may be claimed by the browser before T3 Code sees them. Use the desktop app for better keybinding support.";

function keybindingAnchorIds(rows: ReturnType<typeof buildKeybindingRows>) {
  const ids = new Map<string, string>();
  const seen = new Set<KeybindingCommand>();
  for (const row of rows) {
    if (seen.has(row.command)) continue;
    seen.add(row.command);
    ids.set(row.id, keybindingSearchAnchorId(row.command));
  }
  return ids;
}

// Cache rows in a separate hook so the compiler does not rebuild them per search keystroke.
function useKeybindingCatalog() {
  const serverKeybindings = useSettingsScope().environment?.serverConfig?.keybindings;
  const merged = mergeWithDefaultKeybindings(serverKeybindings ?? []);
  return {
    commandOptions: buildKeybindingCommandOptions(merged),
    allRows: buildKeybindingRows(merged),
  };
}

export function KeybindingsSettingsPanel() {
  const { environment: primaryEnvironment, connectedEnvironments } = useSettingsScope();
  const canOpenKeybindingsFile = useEnvironmentScope(
    primaryEnvironment?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  const writableIds = useEnvironmentsWithScope(connectedEnvironments, AuthSettingsWriteScope);
  const canWriteSettings =
    connectedEnvironments.length > 0 &&
    connectedEnvironments.every((target) => writableIds.has(target.environmentId));
  const keybindingsConfigPath = primaryEnvironment?.serverConfig?.keybindingsConfigPath ?? null;
  const availableEditors = primaryEnvironment?.serverConfig?.availableEditors ?? [];
  const upsertKeybinding = useAtomCommand(serverEnvironment.upsertKeybinding, {
    reportFailure: false,
  });
  const removeKeybindingMutation = useAtomCommand(serverEnvironment.removeKeybinding, {
    reportFailure: false,
  });
  const openInPreferredEditor = useOpenInPreferredEditor(
    primaryEnvironment?.environmentId ?? null,
    availableEditors,
  );
  const [query, setQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [savingCommand, setSavingCommand] = useState<KeybindingCommand | null>(null);
  const [isAddingBinding, setIsAddingBinding] = useState(false);
  const searchTargetId = useLocation({ select: (location) => location.hash.replace(/^#/, "") });
  const [handledSearchTargetId, setHandledSearchTargetId] = useState(searchTargetId);

  if (searchTargetId !== handledSearchTargetId) {
    setHandledSearchTargetId(searchTargetId);
    if (searchTargetId.startsWith("keybinding-")) setQuery("");
  }
  const whenVariables = buildWhenVariableOptions();
  const { commandOptions, allRows } = useKeybindingCatalog();
  const rows = filterKeybindingRows(allRows, query);

  const openKeybindingsFile = () => {
    if (
      !keybindingsConfigPath ||
      !primaryEnvironment ||
      !readEnvironmentScope(primaryEnvironment.environmentId, AuthOrchestrationOperateScope)
    )
      return;
    void (async () => {
      const result = await openInPreferredEditor(keybindingsConfigPath);
      if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
        return;
      }
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        title: "Unable to open keybindings file",
        description:
          error instanceof Error ? error.message : "The keybindings file was not opened.",
        type: "error",
      });
    })();
  };

  const addButtonRef = useRef<HTMLButtonElement>(null);
  const saveKeybinding = (input: ServerUpsertKeybindingInput) => {
    if (
      !primaryEnvironment ||
      !connectedEnvironments.every((target) =>
        readEnvironmentScope(target.environmentId, AuthSettingsWriteScope),
      )
    )
      return;
    setSavingCommand(input.command);
    const payload: ServerUpsertKeybindingInput = {
      command: input.command,
      key: input.key.trim(),
      ...(input.when?.trim() ? { when: input.when.trim() } : {}),
      ...(input.replace ? { replace: input.replace } : {}),
    };
    void (async () => {
      const results = await Promise.all(
        connectedEnvironments.map((target) =>
          upsertKeybinding({ environmentId: target.environmentId, input: payload }),
        ),
      );
      setSavingCommand(null);
      const failed = results.find((result) => result._tag === "Failure");
      if (!failed) {
        flushSync(() => setIsAddingBinding(false));
        // The saved row may disappear with focus inside it.
        if (document.activeElement === document.body) addButtonRef.current?.focus();
        return;
      }
      if (!isAtomCommandInterrupted(failed)) {
        const error = squashAtomCommandFailure(failed);
        toastManager.add({
          title: "Unable to save keybinding",
          description: error instanceof Error ? error.message : "The keybinding was not saved.",
          type: "error",
        });
      }
    })();
  };

  const removeKeybinding = (row: KeybindingRow) => {
    if (
      !primaryEnvironment ||
      !connectedEnvironments.every((target) =>
        readEnvironmentScope(target.environmentId, AuthSettingsWriteScope),
      )
    )
      return;
    setSavingCommand(row.command);
    void (async () => {
      const results = await Promise.all(
        connectedEnvironments.map((target) =>
          removeKeybindingMutation({
            environmentId: target.environmentId,
            input: rowKeybindingTarget(row),
          }),
        ),
      );
      setSavingCommand(null);
      const result = results.find((entry) => entry._tag === "Failure") ?? results[0];
      if (result?._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          title: "Unable to remove keybinding",
          description: error instanceof Error ? error.message : "The keybinding was not removed.",
          type: "error",
        });
      }
    })();
  };

  const resetKeybinding = (row: KeybindingRow) => {
    if (!row.defaultKey) return;
    saveKeybinding({
      command: row.command,
      key: row.defaultKey,
      when: row.defaultWhen.trim().length > 0 ? row.defaultWhen : undefined,
      replace: {
        command: row.command,
        key: row.key,
        ...(row.when.trim().length > 0 ? { when: row.when } : {}),
      },
    });
  };

  // The focused row goes away, so focus returns to the re-enabled "Add keybinding".
  const cancelAdd = () => {
    flushSync(() => setIsAddingBinding(false));
    addButtonRef.current?.focus();
  };

  const listProps: KeybindingsListProps = {
    rows,
    allRows,
    commandOptions,
    variables: whenVariables,
    savingCommand,
    isAddingBinding,
    onCancelAdd: cancelAdd,
    query,
    onClearQuery: () => setQuery(""),
    onSave: saveKeybinding,
    onReset: resetKeybinding,
    onRemove: removeKeybinding,
  };

  return (
    <SettingsPageContainer>
      <SettingsToolbar>
        <SettingsSearchField
          value={query}
          onChange={setQuery}
          placeholder="Search keybindings"
          inputRef={searchInputRef}
        />
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={!keybindingsConfigPath || !canOpenKeybindingsFile}
          onClick={openKeybindingsFile}
          aria-label="Open keybindings.json"
        >
          <FileJsonIcon />
          Open keybindings.json
        </Button>
        <Button
          type="button"
          ref={addButtonRef}
          size="sm"
          disabled={isAddingBinding || !canWriteSettings}
          onClick={() => setIsAddingBinding(true)}
        >
          <PlusIcon />
          Add keybinding
        </Button>
      </SettingsToolbar>
      <SettingsSection
        {...searchableSetting("keybindings")}
        title="Shortcuts"
        warning={isElectron ? undefined : BROWSER_KEYBINDING_WARNING}
      >
        {!canWriteSettings ? (
          <p className="px-4 py-3 text-meta text-muted-foreground">
            {connectedEnvironments.length === 0
              ? "Connect an environment to change keybindings."
              : "This connection can view keybindings but cannot change them."}
          </p>
        ) : null}
        <div inert={!canWriteSettings} className="@container/keybindings">
          <KeybindingsList {...listProps} />
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
