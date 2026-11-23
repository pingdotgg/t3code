import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { m as resolveMessage } from "~/i18n/messages";
import { useEnvironmentScope } from "../../state/session";
import { useEnvironmentsWithScope, readEnvironmentScope } from "../../state/session";
import {
  ChevronDownIcon,
  CircleXIcon,
  EllipsisIcon,
  FileJsonIcon,
  MinusIcon,
  PlusIcon,
  SearchIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { useLocation } from "@tanstack/react-router";
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useReducer,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { T, useGT, useMessages } from "gt-react";
import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  type KeybindingCommand,
  type KeybindingShortcut,
  type KeybindingWhenNode,
  type ServerRemoveKeybindingInput,
  type ServerUpsertKeybindingInput,
} from "@t3tools/contracts";
import {
  mergeWithDefaultKeybindings,
  parseKeybindingWhenExpression,
} from "@t3tools/shared/keybindings";
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
import { useClientSettings } from "../../hooks/useSettings";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Kbd, KbdGroup } from "../ui/kbd";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import {
  Combobox,
  ComboboxTrigger,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxEmpty,
  ComboboxList,
  ComboboxItem,
} from "../ui/combobox";
import {
  SelectButton,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
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
  groupKeybindingRows,
  shortcutToKeybindingParts,
  type KeybindingCommandOption,
  type KeybindingGroup,
  type KeybindingRow,
  type WhenVariableOption,
  unknownWhenVariables,
  whenAstToExpression,
  whenNodeRemoveLabel,
} from "./KeybindingsSettings.logic";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { keybindingSearchAnchorId, useSearchableSetting } from "./settingsSearch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useAtomCommand } from "../../state/use-atom-command";

function KeybindingPill({ shortcut }: { shortcut: KeybindingShortcut }) {
  const isMac = navigator.platform.toLowerCase().includes("mac");
  const parts = shortcutToKeybindingParts(shortcut);
  const modifierParts = parts.slice(0, -1);
  const keyPart = parts.at(-1);

  return (
    <KbdGroup>
      {modifierParts.map((part) => (
        <Kbd key={part}>
          {part === "mod"
            ? isMac
              ? "⌘"
              : "Ctrl"
            : part === "shift"
              ? "⇧"
              : part === "alt"
                ? isMac
                  ? "⌥"
                  : "Alt"
                : part === "ctrl"
                  ? "⌃"
                  : part}
        </Kbd>
      ))}
      {keyPart !== undefined ? (
        <Kbd key="key">{keyPart.length === 1 ? keyPart.toUpperCase() : keyPart}</Kbd>
      ) : null}
    </KbdGroup>
  );
}

function KeybindingsSearchInput({
  query,
  onChange,
  inputRef,
}: {
  query: string;
  onChange: (next: string) => void;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const gt = useGT();
  return (
    <InputGroup className="min-w-0 basis-full **:[input]:h-9 sm:basis-0 sm:flex-1 sm:**:[input]:h-8">
      <InputGroupAddon>
        <SearchIcon aria-hidden className="size-3.5" />
      </InputGroupAddon>
      <InputGroupInput
        ref={inputRef}
        type="search"
        value={query}
        onChange={(event) => onChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          if (query.length > 0) {
            event.stopPropagation();
            onChange("");
          } else event.currentTarget.blur();
        }}
        placeholder={gt("Search keybindings")}
        aria-label={gt("Search keybindings")}
        size="sm"
      />
    </InputGroup>
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
              "inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-warning outline-none transition-colors hover:bg-warning/10 focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-warning/25",
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
  const gt = useGT();
  if (identifiers.length === 0) return null;
  const label =
    identifiers.length === 1
      ? gt("Unknown condition: {condition}", { condition: identifiers[0] })
      : gt("Unknown conditions: {conditions}", { conditions: identifiers.join(", ") });

  return (
    <WarningTooltipIcon label={label} focusable={focusable} className="size-4.5">
      <T>
        T3 Code does not recognize this condition yet. It can still be saved, but it may not match
        unless the runtime provides it.
      </T>
    </WarningTooltipIcon>
  );
}

function KeybindingConflictWarning({ labels }: { labels: ReadonlyArray<string> }) {
  const gt = useGT();
  if (labels.length === 0) return null;
  const description =
    labels.length === 1
      ? gt("Conflicts with {command}.", { command: labels[0] })
      : labels.length > 3
        ? gt("Conflicts with {commands}, and more.", { commands: labels.slice(0, 3).join(", ") })
        : gt("Conflicts with {commands}.", { commands: labels.slice(0, 3).join(", ") });

  return (
    <WarningTooltipIcon label={description}>
      {description} <T>The most recent matching binding wins when both conditions can apply.</T>
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
  const gt = useGT();
  const selected = variables.find((option) => option === value);
  const options =
    selected || variables.some((option) => option === value) ? variables : [value, ...variables];

  return (
    <Select value={value} onValueChange={(nextValue) => nextValue && onChange(nextValue)}>
      <SelectTrigger size="compact" className="min-w-0 flex-1">
        <SelectValue placeholder={gt("Condition")} />
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
  const gt = useGT();
  const m = useMessages();
  const condition = conditionParts(node);

  if (condition) {
    const unknownIdentifiers = isKnownWhenVariable(condition.identifier)
      ? []
      : [condition.identifier];

    return (
      <div className="flex items-center gap-2 rounded-md border border-border/70 bg-background/60 px-2 py-2">
        <Toggle
          pressed={condition.negated}
          onPressedChange={(pressed) => onChange(setConditionNegated(node, pressed))}
          aria-label={gt("Negate {condition}", { condition: condition.identifier })}
          variant="outline"
          size="compact"
          className="min-w-10"
        >
          {gt("Not", { $context: "logical negation toggle" })}
        </Toggle>
        <WhenVariableSelect
          value={condition.identifier}
          variables={variables}
          unknownIdentifiers={unknownIdentifiers}
          onChange={(value) => onChange(setConditionIdentifier(node, value))}
        />
        {onRemove ? (
          <WhenExpressionRemoveButton
            label={whenNodeRemoveLabel(node, depth, m)}
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
          "space-y-2 rounded-lg border border-border/70 bg-muted/20 p-2",
          depth > 0 && "border-border/50 bg-background/50",
        )}
      >
        <div className="flex items-center gap-2">
          <Toggle
            pressed
            onPressedChange={(pressed) => onChange(pressed ? node : node.node)}
            aria-label={gt("Negate group")}
            variant="outline"
            size="compact"
            className="min-w-10"
          >
            {gt("Not", { $context: "logical negation toggle" })}
          </Toggle>
          {onRemove ? (
            <WhenExpressionRemoveButton
              label={whenNodeRemoveLabel(node, depth, m)}
              className="ms-auto"
              onRemove={onRemove}
            />
          ) : null}
        </div>
        <div className="relative ps-4">
          <span className="absolute top-0 bottom-0 start-1.5 w-px bg-border/70" aria-hidden />
          <span className="absolute top-4 start-1.5 h-px w-2.5 bg-border/70" aria-hidden />
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
        "space-y-2 rounded-lg border border-border/60 bg-muted/10 p-2",
        depth > 0 && "border-border/70 bg-background/55",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Select value={operator} onValueChange={(value) => setOperator(value as BooleanOperator)}>
          <SelectTrigger size="compact" className="w-24">
            <SelectValue />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false} matchTriggerWidth={false}>
            <SelectItem value="and">
              {gt("and", { $context: "logical operator in a when clause" })}
            </SelectItem>
            <SelectItem value="or">
              {gt("or", { $context: "logical operator in a when clause" })}
            </SelectItem>
          </SelectContent>
        </Select>
        <Button type="button" variant="outline" size="compact" onClick={addCondition}>
          <PlusIcon className="size-3.5" />
          {gt("Condition", { $context: "button, adds a when-clause condition" })}
        </Button>
        <Button type="button" variant="outline" size="compact" onClick={addGroup}>
          <PlusIcon className="size-3.5" />
          {gt("Group", { $context: "button, adds a group of when-clause conditions" })}
        </Button>
        {onRemove ? (
          <WhenExpressionRemoveButton
            label={whenNodeRemoveLabel(node, depth, m)}
            className="ms-auto"
            onRemove={onRemove}
          />
        ) : null}
      </div>
      <div className="space-y-2">
        {childEntries.map(({ child, key }) => (
          <div key={key} className="relative ps-4">
            <span
              className={cn(
                "absolute top-0 bottom-0 start-1.5 w-px",
                depth === 0 ? "bg-border" : "bg-border/70",
              )}
              aria-hidden
            />
            <span
              className={cn(
                "absolute top-4 start-1.5 h-px w-2.5",
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
  const gt = useGT();
  const m = useMessages();
  const expression = whenAstToExpression(value);
  const [expressionDraft, setExpressionDraft] = useState(expression);
  const parseResult = parseWhenExpressionDraft(expressionDraft, m);
  const parseError = parseResult.ok ? null : parseResult.message;
  const unknownIdentifiers = parseResult.ok ? unknownWhenVariables(parseResult.value) : [];

  const updateExpressionDraft = (nextExpression: string) => {
    setExpressionDraft(nextExpression);
    const nextResult = parseWhenExpressionDraft(nextExpression, m);
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
          <div className="text-sm font-medium text-foreground">
            {gt("When", { $context: "heading for keybinding conditions" })}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button type="button" variant="outline" size="compact" onClick={addRootCondition}>
            <PlusIcon className="size-3.5" />
            {gt("Condition", { $context: "button, adds a when-clause condition" })}
          </Button>
          <Button type="button" variant="outline" size="compact" onClick={addRootGroup}>
            <PlusIcon className="size-3.5" />
            {gt("Group", { $context: "button, adds a group of when-clause conditions" })}
          </Button>
        </div>
      </div>

      <div className="space-y-1.5">
        <InputGroup>
          <InputGroupInput
            value={expressionDraft}
            onChange={(event) => updateExpressionDraft(event.currentTarget.value)}
            placeholder={gt("Always")}
            aria-invalid={Boolean(parseError)}
            aria-label={gt("When expression")}
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
          <div className="flex items-center gap-1.5 text-2xs text-destructive">
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
          <div className="rounded-md border border-dashed border-border/80 bg-muted/15 p-3">
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="compact" onClick={addRootCondition}>
                <PlusIcon className="size-3.5" />
                {gt("Condition", { $context: "button, adds a when-clause condition" })}
              </Button>
              <Button type="button" variant="outline" size="compact" onClick={addRootGroup}>
                <PlusIcon className="size-3.5" />
                {gt("Group", { $context: "button, adds a group of when-clause conditions" })}
              </Button>
            </div>
          </div>
        )}
        {parseError ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg border border-destructive/30 bg-background/75 p-4 text-center text-xs text-destructive backdrop-blur-xs">
            <T>Fix the expression above to continue editing visually.</T>
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
}: {
  row: KeybindingRow;
  allRows: ReadonlyArray<KeybindingRow>;
  onSave: (input: ServerUpsertKeybindingInput) => void;
}) {
  const m = useMessages();
  const [draft, setDraft] = useReducer(keybindingRowDraftReducer, row, createKeybindingRowDraft);
  const pillRef = useRef<HTMLButtonElement>(null);
  const { keyDraft, whenDraft, isRecording, isWhenDraftValid } = draft;
  const whenDraftExpression = whenAstToExpression(whenDraft);
  const isDirty = keyDraft !== row.key || whenDraftExpression !== row.when;
  const conflictLabels = keybindingConflictLabels(
    allRows,
    {
      rowId: row.id,
      key: keyDraft,
      when: whenDraftExpression,
    },
    navigator.platform,
    m,
  );

  // Giving an unassigned row a shortcut brings back its default condition.
  const setKeyDraft = (next: string, patch: Partial<KeybindingRowDraftState> = {}) =>
    setDraft({
      ...patch,
      keyDraft: next,
      ...(row.isUnassigned && whenDraftExpression === "false"
        ? { whenDraft: parseKeybindingWhenExpression(row.defaultWhen) ?? undefined }
        : {}),
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
      flushSync(() =>
        setDraft({
          keyDraft: row.key,
          isRecording: false,
          ...(row.isUnassigned && whenDraftExpression === row.defaultWhen
            ? { whenDraft: parseKeybindingWhenExpression(row.when) ?? undefined }
            : {}),
        }),
      );
      // The field may unmount for the pill; focus would otherwise drop to the page.
      if (pillRef.current) pillRef.current.focus();
      else field.blur();
      return;
    }
    const next = keybindingFromKeyboardEvent(event.nativeEvent, navigator.platform, {
      layoutCharacter: true,
    });
    if (!next) return;
    setKeyDraft(next, { isRecording: false });
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
    setKeyDraft,
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
  onUnassign: (row: KeybindingRow) => void;
  onRemove: (row: KeybindingRow) => void;
}

type KeybindingRowProps = KeybindingRowActions & {
  row: KeybindingRow;
  isSaving: boolean;
  anchorId?: string | undefined;
};

function KeybindingKeyControl({
  row,
  editor,
  isSaving,
  pillClassName,
}: {
  row: KeybindingRow;
  editor: KeybindingRowEditor;
  isSaving: boolean;
  pillClassName?: string | undefined;
}) {
  const {
    keyDraft,
    isRecording,
    isDirty,
    isWhenDraftValid,
    setDraft,
    setKeyDraft,
    save,
    captureKeybinding,
    pillRef,
  } = editor;
  const gt = useGT();
  const m = useMessages();
  const showPill = !isRecording && keyDraft === row.key && row.key.length > 0 && !isDirty;

  return (
    <>
      {isDirty ? (
        <Button
          size="sm"
          disabled={isSaving || keyDraft.trim().length === 0 || !isWhenDraftValid}
          onClick={save}
        >
          {isSaving ? gt("Saving") : gt("Save", { $context: "verb" })}
        </Button>
      ) : null}
      {showPill ? (
        <button
          ref={pillRef}
          type="button"
          onClick={() => setDraft({ isRecording: true })}
          aria-label={gt("Edit shortcut for {command}: {shortcut}", {
            command: commandLabel(row.command, m),
            shortcut: row.isUnassigned
              ? gt("Unassigned", { $context: "keyboard shortcut with no key assigned" })
              : formatShortcutLabel(row.binding.shortcut),
          })}
          className={cn(
            "inline-flex h-8 cursor-pointer items-center rounded-md border border-transparent px-1.5 sm:h-7 outline-none transition-colors hover:border-border/70 hover:bg-accent focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/24",
            pillClassName,
          )}
        >
          {row.isUnassigned ? (
            <span className="text-sm text-muted-foreground">
              <T context="keyboard shortcut with no key assigned">Unassigned</T>
            </span>
          ) : (
            <KeybindingPill shortcut={row.binding.shortcut} />
          )}
        </button>
      ) : (
        <Input
          data-keybinding-capture=""
          autoFocus={isRecording}
          aria-label={gt("Keybinding for {command}", { command: commandLabel(row.command, m) })}
          value={isRecording ? "" : keyDraft}
          placeholder={isRecording ? gt("Press shortcut") : gt("Unassigned")}
          size="sm"
          font="mono"
          className="w-44"
          onFocus={() => setDraft({ isRecording: true })}
          onBlur={() => setDraft({ isRecording: false })}
          onChange={(event) => setKeyDraft(event.currentTarget.value)}
          onKeyDown={captureKeybinding}
        />
      )}
    </>
  );
}

function WhenClauseControl({
  editLabel,
  expression,
  value,
  variables,
  onChange,
  onValidityChange,
}: {
  editLabel: string;
  expression: string;
  value: KeybindingWhenNode | undefined;
  variables: ReadonlyArray<WhenVariableOption>;
  onChange: (value: KeybindingWhenNode | undefined) => void;
  onValidityChange: (valid: boolean) => void;
}) {
  // Closing unmounts the builder, which drops an unparsed draft and keeps the last valid value.
  const gt = useGT();
  const handleOpenChange = (open: boolean) => {
    if (!open) onValidityChange(true);
  };

  return (
    <Popover onOpenChange={handleOpenChange}>
      <PopoverTrigger
        render={
          <Button
            variant={expression ? "ghost" : "ghost-muted"}
            size="micro"
            className="min-w-0 shrink"
          />
        }
        aria-label={editLabel}
      >
        <span className="truncate font-mono">{expression || gt("Always")}</span>
        <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" />
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
  onUnassign,
  onRemove,
}: {
  row: KeybindingRow;
  isSaving: boolean;
  onReset: (row: KeybindingRow) => void;
  onUnassign: (row: KeybindingRow) => void;
  onRemove: (row: KeybindingRow) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const canReset = row.source === "Custom" && row.defaultKey !== null;
  const canUnassign = row.source === "Default";
  // Reset to default is the way back; removing would drop the default for good.
  const canRemove = row.source !== "Default" && !row.isUnassigned;

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            type="button"
            variant="ghost-muted"
            size="icon-sm"
            disabled={isSaving}
            aria-label={gt("Actions for {command}", { command: commandLabel(row.command, m) })}
          />
        }
      >
        <EllipsisIcon className="size-3.5" />
      </MenuTrigger>
      <MenuPopup align="end">
        {canReset ? (
          <MenuItem disabled={isSaving} onClick={() => onReset(row)}>
            <T>Reset to default</T>
          </MenuItem>
        ) : null}
        {canUnassign ? (
          <MenuItem variant="destructive" disabled={isSaving} onClick={() => onUnassign(row)}>
            {gt("Unassign", { $context: "verb, removes the key from a keyboard shortcut" })}
          </MenuItem>
        ) : null}
        {canRemove ? (
          <MenuItem variant="destructive" disabled={isSaving} onClick={() => onRemove(row)}>
            {gt("Remove", { $context: "verb, removes a keybinding" })}
          </MenuItem>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

function KeybindingSourceBadge({ source }: { source: KeybindingRow["source"] }) {
  const gt = useGT();
  if (source === "Default") return null;
  return (
    <Badge variant="outline" size="sm">
      {source === "Custom"
        ? gt("Custom", { $context: "keybinding source badge" })
        : gt("Project", { $context: "keybinding source badge" })}
    </Badge>
  );
}

function KeybindingRowTitle({ row }: { row: KeybindingRow }) {
  const m = useMessages();
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex items-center gap-2" />}>
        {commandLabel(row.command, m)}
        <KeybindingSourceBadge source={row.source} />
      </TooltipTrigger>
      <TooltipPopup side="top">{row.command}</TooltipPopup>
    </Tooltip>
  );
}

function KeybindingRowWhen({
  row,
  editor,
  variables,
}: {
  row: KeybindingRow;
  editor: KeybindingRowEditor;
  variables: ReadonlyArray<WhenVariableOption>;
}) {
  const gt = useGT();
  const m = useMessages();
  return (
    <span className="flex h-6 items-center gap-1.5">
      <span className="text-xs leading-none text-muted-foreground/70">
        {gt("When", { $context: "heading for keybinding conditions" })}
      </span>
      <WhenClauseControl
        editLabel={gt("Edit when clause for {command}", { command: commandLabel(row.command, m) })}
        expression={editor.whenDraftExpression}
        value={editor.whenDraft}
        variables={variables}
        onChange={(whenDraft) => editor.setDraft({ whenDraft })}
        onValidityChange={(isWhenDraftValid) => editor.setDraft({ isWhenDraftValid })}
      />
    </span>
  );
}

function KeybindingHoverRowMenu(props: {
  row: KeybindingRow;
  isSaving: boolean;
  onReset: (row: KeybindingRow) => void;
  onUnassign: (row: KeybindingRow) => void;
  onRemove: (row: KeybindingRow) => void;
}) {
  return (
    <span className="flex items-center opacity-0 transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100 has-data-popup-open:opacity-100 pointer-coarse:opacity-100">
      <KeybindingRowMenu {...props} />
    </span>
  );
}

function KeybindingSettingsRow(props: KeybindingRowProps) {
  const { row, isSaving, anchorId, allRows, variables, onSave, onReset, onUnassign, onRemove } =
    props;
  const editor = useKeybindingRowEditor({ row, allRows, onSave });

  return (
    <SettingsRow
      id={anchorId}
      className="group/row rounded-none"
      title={<KeybindingRowTitle row={row} />}
      description={
        row.isUnassigned && !editor.isDirty ? (
          <T>No keyboard shortcut assigned. Click Unassigned to set one.</T>
        ) : (
          <KeybindingRowWhen row={row} editor={editor} variables={variables} />
        )
      }
      control={
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <KeybindingConflictWarning labels={editor.conflictLabels} />
          <KeybindingHoverRowMenu
            row={row}
            isSaving={isSaving}
            onReset={onReset}
            onUnassign={onUnassign}
            onRemove={onRemove}
          />
          <KeybindingKeyControl
            row={row}
            editor={editor}
            isSaving={isSaving}
            pillClassName="-me-1.5"
          />
        </div>
      }
    />
  );
}

function useNewKeybindingDraft({
  allRows,
  onSave,
}: {
  allRows: ReadonlyArray<KeybindingRow>;
  onSave: (input: ServerUpsertKeybindingInput) => void;
}) {
  const m = useMessages();
  const [commandDraft, setCommandDraft] = useState<KeybindingCommand | "">("");
  const [draft, setDraft] = useReducer(keybindingRowDraftReducer, {
    keyDraft: "",
    whenDraft: undefined,
    isRecording: false,
    isWhenDraftValid: true,
  });
  const { keyDraft, whenDraft, isRecording, isWhenDraftValid } = draft;
  const whenDraftExpression = whenAstToExpression(whenDraft);
  const conflictLabels = keybindingConflictLabels(
    allRows,
    {
      rowId: "new",
      key: keyDraft,
      when: whenDraftExpression,
    },
    navigator.platform,
    m,
  );
  const commandLabelText = commandDraft ? commandLabel(commandDraft, m) : null;
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
  allRows,
  className,
}: {
  draft: NewKeybindingDraft;
  commandOptions: ReadonlyArray<KeybindingCommandOption>;
  allRows: ReadonlyArray<KeybindingRow>;
  className?: string | undefined;
}) {
  const gt = useGT();
  const m = useMessages();
  const shortcutsByCommand = new Map<
    KeybindingCommand,
    Array<{ id: string; label: string; when: string }>
  >();
  for (const row of allRows) {
    for (const label of row.previewLabels) {
      const shortcuts = shortcutsByCommand.get(row.command) ?? [];
      shortcuts.push({ id: `${row.id}:${label}`, label, when: row.when });
      shortcutsByCommand.set(row.command, shortcuts);
    }
  }
  return (
    <Combobox
      items={commandOptions}
      defaultOpen
      itemToStringLabel={(command) => commandLabel(command, m)}
      filter={(command, query) =>
        `${command} ${commandLabel(command, m)}`.toLowerCase().includes(query.trim().toLowerCase())
      }
      autoHighlight
      value={draft.commandDraft || null}
      onValueChange={(value) => value && draft.setCommandDraft(value)}
    >
      <ComboboxTrigger
        aria-label={gt("Command")}
        render={<SelectButton size="sm" />}
        className={className}
      >
        {draft.commandDraft ? commandLabel(draft.commandDraft, m) : gt("Command")}
      </ComboboxTrigger>
      <ComboboxPopup aria-label={gt("Command")} className="w-96">
        <ComboboxSearchInput
          autoFocus
          placeholder={gt("Search", { $context: "search field placeholder" })}
          aria-label={gt("Search", { $context: "search field placeholder" })}
        />
        <ComboboxEmpty>{gt("No results found.")}</ComboboxEmpty>
        <ComboboxList>
          {(command: KeybindingCommandOption) => {
            const shortcuts = shortcutsByCommand.get(command);
            return (
              <ComboboxItem key={command} value={command}>
                <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
                  <span>{commandLabel(command, m)}</span>
                  {shortcuts && (
                    <span className="flex shrink-0 flex-col items-end gap-1">
                      {shortcuts.map((shortcut) => (
                        <Kbd key={shortcut.id} title={shortcut.when || undefined}>
                          {shortcut.label}
                        </Kbd>
                      ))}
                    </span>
                  )}
                </div>
              </ComboboxItem>
            );
          }}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
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
  const gt = useGT();
  return (
    <Input
      data-keybinding-capture=""
      autoFocus={autoFocus}
      aria-label={
        draft.commandLabelText === null
          ? gt("Keybinding for new keybinding")
          : gt("Keybinding for {command}", { command: draft.commandLabelText })
      }
      value={draft.isRecording ? "" : draft.keyDraft}
      placeholder={draft.isRecording ? gt("Press shortcut") : gt("Unassigned")}
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
  const gt = useGT();
  return (
    <WhenClauseControl
      editLabel={
        draft.commandLabelText === null
          ? gt("Edit when clause for new keybinding")
          : gt("Edit when clause for {command}", { command: draft.commandLabelText })
      }
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
  const gt = useGT();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost-muted"
            size="icon-sm"
            disabled={isSaving}
            aria-label={gt("Cancel new keybinding")}
            onClick={onCancel}
          />
        }
      >
        <XIcon className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">
        <T>Cancel</T>
      </TooltipPopup>
    </Tooltip>
  );
}

function NewKeybindingSettingsRow(props: NewKeybindingProps) {
  const { commandOptions, allRows, variables, isSaving, onSave, onCancel } = props;
  const draft = useNewKeybindingDraft({ allRows, onSave });
  const gt = useGT();

  return (
    <SettingsRow
      className="bg-muted/15"
      title={gt("New keybinding")}
      description={
        <span className="flex h-6 items-center gap-1.5">
          <span className="text-xs leading-none text-muted-foreground/70">
            {gt("When", { $context: "heading for keybinding conditions" })}
          </span>
          <NewKeybindingWhen draft={draft} variables={variables} />
        </span>
      }
      control={
        <div className="flex flex-wrap items-center gap-2">
          <NewKeybindingCommandSelect
            draft={draft}
            commandOptions={commandOptions}
            allRows={allRows}
            className="w-56"
          />
          <KeybindingConflictWarning labels={draft.conflictLabels} />
          <NewKeybindingKeyInput draft={draft} className="w-44" />
          <Button size="sm" disabled={isSaving || !draft.canSave} onClick={draft.save}>
            {isSaving ? gt("Saving") : gt("Save", { $context: "verb" })}
          </Button>
          <NewKeybindingCancelIcon isSaving={isSaving} onCancel={onCancel} />
        </div>
      }
    />
  );
}

interface KeybindingsGroupsProps extends KeybindingRowActions {
  groups: ReadonlyArray<KeybindingGroup>;
  anchorIds: ReadonlyMap<string, string>;
  savingCommand: KeybindingCommand | null;
}

function KeybindingsGroups(props: KeybindingsGroupsProps) {
  const { groups, anchorIds, savingCommand, ...rowActions } = props;
  const m = useMessages();
  return groups.map((group) => (
    <SettingsSection key={group.id} id={`keybindings-${group.id}`} title={m(group.title)}>
      {group.rows.map((row) => (
        <KeybindingSettingsRow
          key={row.id}
          row={row}
          anchorId={anchorIds.get(row.id)}
          isSaving={savingCommand === row.command}
          {...rowActions}
        />
      ))}
    </SettingsSection>
  ));
}

function BrowserKeybindingNotice() {
  const gt = useGT();
  const message = gt(
    "The browser may claim some shortcuts first. The desktop app receives them all.",
  );
  return (
    <Tooltip>
      <TooltipTrigger
        delay={200}
        render={
          <Button size="icon-micro" variant="ghost-muted" aria-label={message}>
            <TriangleAlertIcon className="size-3.5 text-warning" />
          </Button>
        }
      />
      <TooltipPopup side="top" className="max-w-72">
        {message}
      </TooltipPopup>
    </Tooltip>
  );
}

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
  const sendShortcut = useClientSettings((settings) => settings.sendShortcut);
  const serverKeybindings = useSettingsScope().environment?.serverConfig?.keybindings;
  const merged = mergeWithDefaultKeybindings(serverKeybindings ?? []);
  const m = useMessages();
  return {
    commandOptions: buildKeybindingCommandOptions(merged, m),
    allRows: buildKeybindingRows(merged, navigator.platform, sendShortcut, m),
  };
}

export function KeybindingsSettingsPanel() {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const m = useMessages();
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
  const rows = filterKeybindingRows(allRows, query, m);
  const groups = groupKeybindingRows(rows);
  const anchorIds = keybindingAnchorIds(rows);

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
        title: gt("Unable to open keybindings file"),
        description:
          error instanceof Error
            ? (thrownErrorMessage(error, resolveMessage) ?? error.message)
            : gt("The keybindings file was not opened."),
        type: "error",
      });
    })();
  };

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
        setIsAddingBinding(false);
        return;
      }
      if (!isAtomCommandInterrupted(failed)) {
        const error = squashAtomCommandFailure(failed);
        toastManager.add({
          title: gt("Unable to save keybinding"),
          description:
            error instanceof Error
              ? (thrownErrorMessage(error, resolveMessage) ?? error.message)
              : gt("The keybinding was not saved."),
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
          title: gt("Unable to remove keybinding"),
          description:
            error instanceof Error
              ? (thrownErrorMessage(error, resolveMessage) ?? error.message)
              : gt("The keybinding was not removed."),
          type: "error",
        });
      }
    })();
  };

  const unassignKeybinding = (row: KeybindingRow) => {
    if (row.source !== "Default") return;
    saveKeybinding({
      command: row.command,
      key: row.key,
      when: "false",
      replace: rowKeybindingTarget(row),
    });
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

  const cancelAdd = () => setIsAddingBinding(false);

  const rowActions: KeybindingRowActions = {
    allRows,
    variables: whenVariables,
    onSave: saveKeybinding,
    onReset: resetKeybinding,
    onUnassign: unassignKeybinding,
    onRemove: removeKeybinding,
  };

  return (
    <SettingsPageContainer>
      <SettingsSection
        {...searchableSetting("keybindings")}
        headerAction={!isElectron ? <BrowserKeybindingNotice /> : null}
      >
        <div className="flex flex-wrap items-center gap-2 px-3 py-3 sm:px-4">
          <KeybindingsSearchInput query={query} onChange={setQuery} inputRef={searchInputRef} />
          <Button
            type="button"
            variant="outline"
            disabled={isAddingBinding || !canWriteSettings}
            onClick={() => setIsAddingBinding(true)}
          >
            <PlusIcon aria-hidden className="size-4" />
            <T>Add keybinding</T>
          </Button>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  disabled={!keybindingsConfigPath || !canOpenKeybindingsFile}
                  onClick={openKeybindingsFile}
                  aria-label={gt("Open keybindings.json")}
                >
                  <FileJsonIcon aria-hidden className="size-4" />
                </Button>
              }
            />
            <TooltipPopup side="top">
              <T>Open keybindings.json</T>
            </TooltipPopup>
          </Tooltip>
        </div>
      </SettingsSection>

      {!canWriteSettings ? (
        <p className="text-xs text-muted-foreground">
          {connectedEnvironments.length === 0
            ? gt("Connect an environment to change keybindings.")
            : gt("This connection can view keybindings but cannot change them.")}
        </p>
      ) : null}
      <div inert={!canWriteSettings} className="flex flex-col gap-8">
        {isAddingBinding ? (
          <SettingsGroup>
            <NewKeybindingSettingsRow
              commandOptions={commandOptions}
              allRows={allRows}
              variables={whenVariables}
              isSaving={savingCommand !== null}
              onSave={saveKeybinding}
              onCancel={cancelAdd}
            />
          </SettingsGroup>
        ) : null}

        {groups.length > 0 ? (
          <KeybindingsGroups
            groups={groups}
            anchorIds={anchorIds}
            savingCommand={savingCommand}
            {...rowActions}
          />
        ) : (
          <SettingsGroup>
            <div className="px-4 py-12 text-center text-sm text-muted-foreground">
              <T>No keybindings match your search.</T>
            </div>
          </SettingsGroup>
        )}
      </div>
    </SettingsPageContainer>
  );
}
