import { useT } from "../../hooks/useI18n";
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
  groupKeybindingRows,
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
import { keybindingSearchAnchorId, searchableSetting } from "./settingsSearch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useAtomCommand } from "../../state/use-atom-command";

function KeybindingPill({ value }: { value: string }) {
  // Keys dedupe repeated parts; a literal "+" in a shortcut splits into empty strings.
  const seenParts = new Map<string, number>();
  const parts = value.split("+").map((part) => {
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

function KeybindingsSearchInput({
  query,
  onChange,
  inputRef,
}: {
  query: string;
  onChange: (next: string) => void;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const t = useT();
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
          if (query.length > 0) onChange("");
          else event.currentTarget.blur();
        }}
        placeholder={t("settings.providers.keybindings.search")}
        aria-label={t("settings.providers.keybindings.search")}
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
  const t = useT();
  if (identifiers.length === 0) return null;
  const label =
    identifiers.length === 1
      ? t("settings.providers.keybindings.unknownOne", { condition: String(identifiers[0]) })
      : t("settings.providers.keybindings.unknownMany", {
          conditions: String(identifiers.join(", ")),
        });

  return (
    <WarningTooltipIcon label={label} focusable={focusable} className="size-4.5">
      {t("settings.providers.keybindings.unrecognized")}
    </WarningTooltipIcon>
  );
}

function KeybindingConflictWarning({ labels }: { labels: ReadonlyArray<string> }) {
  const t = useT();
  if (labels.length === 0) return null;
  const description =
    labels.length === 1
      ? t("settings.providers.keybindings.conflictOne", { label: String(labels[0]) })
      : t("settings.providers.keybindings.conflictMany", {
          labels: `${labels.slice(0, 3).join(", ")}${labels.length > 3 ? t("settings.providers.keybindings.andMore") : ""}`,
        });

  return (
    <WarningTooltipIcon label={description}>
      {t("settings.providers.keybindings.conflictWins", { description })}
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
  const t = useT();
  const selected = variables.find((option) => option === value);
  const options =
    selected || variables.some((option) => option === value) ? variables : [value, ...variables];

  return (
    <Select value={value} onValueChange={(nextValue) => nextValue && onChange(nextValue)}>
      <SelectTrigger size="compact" className="min-w-0 flex-1">
        <SelectValue placeholder={t("settings.providers.keybindings.condition")} />
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
  const t = useT();
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
          aria-label={t("settings.providers.keybindings.negate", {
            condition: String(condition.identifier),
          })}
          variant="outline"
          size="compact"
          className="min-w-10"
        >
          {t("settings.providers.keybindings.not")}
        </Toggle>
        <WhenVariableSelect
          value={condition.identifier}
          variables={variables}
          unknownIdentifiers={unknownIdentifiers}
          onChange={(value) => onChange(setConditionIdentifier(node, value))}
        />
        {onRemove ? (
          <WhenExpressionRemoveButton
            label={whenNodeRemoveLabel(node, depth, t)}
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
            aria-label={t("settings.providers.keybindings.negateGroup")}
            variant="outline"
            size="compact"
            className="min-w-10"
          >
            {t("settings.providers.keybindings.not")}
          </Toggle>
          {onRemove ? (
            <WhenExpressionRemoveButton
              label={whenNodeRemoveLabel(node, depth, t)}
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
            <SelectItem value="and">{t("settings.providers.keybindings.and")}</SelectItem>
            <SelectItem value="or">{t("settings.providers.keybindings.or")}</SelectItem>
          </SelectContent>
        </Select>
        <Button type="button" variant="outline" size="compact" onClick={addCondition}>
          <PlusIcon className="size-3.5" />
          {t("settings.providers.keybindings.condition")}
        </Button>
        <Button type="button" variant="outline" size="compact" onClick={addGroup}>
          <PlusIcon className="size-3.5" />
          {t("settings.providers.keybindings.group")}
        </Button>
        {onRemove ? (
          <WhenExpressionRemoveButton
            label={whenNodeRemoveLabel(node, depth, t)}
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
  const t = useT();
  const expression = whenAstToExpression(value);
  const [expressionDraft, setExpressionDraft] = useState(expression);
  const parseResult = parseWhenExpressionDraft(expressionDraft, t);
  const parseError = parseResult.ok ? null : parseResult.message;
  const unknownIdentifiers = parseResult.ok ? unknownWhenVariables(parseResult.value) : [];

  const updateExpressionDraft = (nextExpression: string) => {
    setExpressionDraft(nextExpression);
    const nextResult = parseWhenExpressionDraft(nextExpression, t);
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
    updateExpressionValue({
      type: "and",
      left: value,
      right: defaultWhenCondition(),
    });
  };

  const addRootGroup = () => {
    const group = defaultWhenGroup("or");
    if (!value) {
      updateExpressionValue(group);
      return;
    }
    updateExpressionValue({
      type: "and",
      left: value,
      right: group,
    });
  };

  return (
    <div className="w-[min(34rem,calc(100vw-2rem))] space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">
            {t("settings.providers.keybindings.when")}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button type="button" variant="outline" size="compact" onClick={addRootCondition}>
            <PlusIcon className="size-3.5" />
            {t("settings.providers.keybindings.condition")}
          </Button>
          <Button type="button" variant="outline" size="compact" onClick={addRootGroup}>
            <PlusIcon className="size-3.5" />
            {t("settings.providers.keybindings.group")}
          </Button>
        </div>
      </div>

      <div className="space-y-1.5">
        <InputGroup>
          <InputGroupInput
            value={expressionDraft}
            onChange={(event) => updateExpressionDraft(event.currentTarget.value)}
            placeholder={t("settings.providers.keybindings.always")}
            aria-invalid={Boolean(parseError)}
            aria-label={t("settings.providers.keybindings.expressionA11y")}
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
                {t("settings.providers.keybindings.condition")}
              </Button>
              <Button type="button" variant="outline" size="compact" onClick={addRootGroup}>
                <PlusIcon className="size-3.5" />
                {t("settings.providers.keybindings.group")}
              </Button>
            </div>
          </div>
        )}
        {parseError ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg border border-destructive/30 bg-background/75 p-4 text-center text-xs text-destructive backdrop-blur-xs">
            {t("settings.providers.keybindings.fixExpression")}
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
  const t = useT();
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
    undefined,
    t,
  );

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
  const t = useT();
  const {
    keyDraft,
    isRecording,
    isDirty,
    isWhenDraftValid,
    setDraft,
    save,
    captureKeybinding,
    pillRef,
  } = editor;
  const showPill = !isRecording && keyDraft === row.key && row.key.length > 0 && !isDirty;

  return (
    <>
      {isDirty ? (
        <Button
          size="sm"
          disabled={isSaving || keyDraft.trim().length === 0 || !isWhenDraftValid}
          onClick={save}
        >
          {isSaving
            ? t("settings.providers.keybindings.saving")
            : t("settings.providers.keybindings.save")}
        </Button>
      ) : null}
      {showPill ? (
        <button
          ref={pillRef}
          type="button"
          onClick={() => setDraft({ isRecording: true })}
          aria-label={t("settings.providers.keybindings.editShortcut", {
            command: String(commandLabel(row.command, t)),
            shortcut: String(formatShortcutLabel(row.binding.shortcut)),
          })}
          className={cn(
            "inline-flex h-8 cursor-pointer items-center rounded-md border border-transparent px-1.5 sm:h-7 outline-none transition-colors hover:border-border/70 hover:bg-accent focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/24",
            pillClassName,
          )}
        >
          <KeybindingPill value={row.key} />
        </button>
      ) : (
        <Input
          data-keybinding-capture=""
          autoFocus={isRecording}
          aria-label={t("settings.providers.keybindings.forCommand", {
            command: String(commandLabel(row.command, t)),
          })}
          value={isRecording ? "" : keyDraft}
          placeholder={
            isRecording
              ? t("settings.providers.keybindings.press")
              : t("settings.providers.keybindings.unassigned")
          }
          size="sm"
          font="mono"
          className="w-44"
          onFocus={() => setDraft({ isRecording: true })}
          onBlur={() => setDraft({ isRecording: false })}
          onChange={(event) => setDraft({ keyDraft: event.currentTarget.value })}
          onKeyDown={captureKeybinding}
        />
      )}
    </>
  );
}

function WhenClauseControl({
  label,
  expression,
  value,
  variables,
  onChange,
  onValidityChange,
}: {
  label: string;
  expression: string;
  value: KeybindingWhenNode | undefined;
  variables: ReadonlyArray<WhenVariableOption>;
  onChange: (value: KeybindingWhenNode | undefined) => void;
  onValidityChange: (valid: boolean) => void;
}) {
  const t = useT();
  // Closing unmounts the builder, which drops an unparsed draft and keeps the last valid value.
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
        aria-label={t("settings.providers.keybindings.editWhen", { label: String(label) })}
      >
        <span className="truncate font-mono">
          {expression || t("settings.providers.keybindings.always")}
        </span>
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
  onRemove,
}: {
  row: KeybindingRow;
  isSaving: boolean;
  onReset: (row: KeybindingRow) => void;
  onRemove: (row: KeybindingRow) => void;
}) {
  const t = useT();
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
            aria-label={t("settings.providers.keybindings.actions", {
              command: String(commandLabel(row.command, t)),
            })}
          />
        }
      >
        <EllipsisIcon className="size-3.5" />
      </MenuTrigger>
      <MenuPopup align="end">
        {canReset ? (
          <MenuItem disabled={isSaving} onClick={() => onReset(row)}>
            {t("settings.providers.keybindings.reset")}
          </MenuItem>
        ) : null}
        {canRemove ? (
          <MenuItem variant="destructive" disabled={isSaving} onClick={() => onRemove(row)}>
            {t("settings.providers.keybindings.remove")}
          </MenuItem>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

function KeybindingSourceBadge({ source }: { source: KeybindingRow["source"] }) {
  if (source === "Default") return null;
  return (
    <Badge variant="outline" size="sm">
      {source}
    </Badge>
  );
}

function KeybindingRowTitle({ row }: { row: KeybindingRow }) {
  const t = useT();
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex items-center gap-2" />}>
        {commandLabel(row.command, t)}
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
  const t = useT();
  return (
    <span className="flex h-6 items-center gap-1.5">
      <span className="text-xs leading-none text-muted-foreground/70">
        {t("settings.providers.keybindings.when")}
      </span>
      <WhenClauseControl
        label={commandLabel(row.command, t)}
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
  onRemove: (row: KeybindingRow) => void;
}) {
  return (
    <span className="flex items-center opacity-0 transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100 has-data-popup-open:opacity-100 pointer-coarse:opacity-100">
      <KeybindingRowMenu {...props} />
    </span>
  );
}

function KeybindingSettingsRow(props: KeybindingRowProps) {
  const { row, isSaving, anchorId, allRows, variables, onSave, onReset, onRemove } = props;
  const editor = useKeybindingRowEditor({ row, allRows, onSave });

  return (
    <SettingsRow
      id={anchorId}
      className="group/row rounded-none"
      title={<KeybindingRowTitle row={row} />}
      description={<KeybindingRowWhen row={row} editor={editor} variables={variables} />}
      control={
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <KeybindingConflictWarning labels={editor.conflictLabels} />
          <KeybindingHoverRowMenu
            row={row}
            isSaving={isSaving}
            onReset={onReset}
            onRemove={onRemove}
          />
          <KeybindingKeyControl
            row={row}
            editor={editor}
            isSaving={isSaving}
            pillClassName="-mr-1.5"
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
  const t = useT();
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
    undefined,
    t,
  );
  const commandLabelText = commandDraft
    ? commandLabel(commandDraft, t)
    : t("settings.providers.keybindings.newFallback");
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
  const t = useT();
  return (
    <Select
      value={draft.commandDraft}
      onValueChange={(value) => draft.setCommandDraft(value as KeybindingCommand)}
    >
      <SelectTrigger size="sm" className={className}>
        <SelectValue placeholder={t("settings.providers.keybindings.command")} />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false} matchTriggerWidth={false} className="max-h-72">
        {commandOptions.map((command) => (
          <SelectItem key={command} value={command} className="w-full">
            <span className="truncate">{commandLabel(command, t)}</span>
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
  const t = useT();
  return (
    <Input
      data-keybinding-capture=""
      autoFocus={autoFocus}
      aria-label={t("settings.providers.keybindings.forCommand", {
        command: String(draft.commandLabelText),
      })}
      value={draft.isRecording ? "" : draft.keyDraft}
      placeholder={
        draft.isRecording
          ? t("settings.providers.keybindings.press")
          : t("settings.providers.keybindings.unassigned")
      }
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
  const t = useT();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost-muted"
            size="icon-sm"
            disabled={isSaving}
            aria-label={t("settings.providers.keybindings.cancelNew")}
            onClick={onCancel}
          />
        }
      >
        <XIcon className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">{t("settings.providers.keybindings.cancel")}</TooltipPopup>
    </Tooltip>
  );
}

function NewKeybindingSettingsRow(props: NewKeybindingProps) {
  const t = useT();
  const { commandOptions, allRows, variables, isSaving, onSave, onCancel } = props;
  const draft = useNewKeybindingDraft({ allRows, onSave });

  return (
    <SettingsRow
      className="bg-muted/15"
      title={t("settings.providers.keybindings.new")}
      description={
        <span className="flex h-6 items-center gap-1.5">
          <span className="text-xs leading-none text-muted-foreground/70">
            {t("settings.providers.keybindings.when")}
          </span>
          <NewKeybindingWhen draft={draft} variables={variables} />
        </span>
      }
      control={
        <div className="flex flex-wrap items-center gap-2">
          <NewKeybindingCommandSelect
            draft={draft}
            commandOptions={commandOptions}
            className="w-56"
          />
          <KeybindingConflictWarning labels={draft.conflictLabels} />
          <NewKeybindingKeyInput draft={draft} className="w-44" />
          <Button size="sm" disabled={isSaving || !draft.canSave} onClick={draft.save}>
            {isSaving
              ? t("settings.providers.keybindings.saving")
              : t("settings.providers.keybindings.save")}
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
  return groups.map((group) => (
    <SettingsSection key={group.id} id={`keybindings-${group.id}`} title={group.title}>
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
  const t = useT();
  const message = t("settings.providers.keybindings.browserNotice");
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
  const t = useT();
  const serverKeybindings = useSettingsScope().environment?.serverConfig?.keybindings;
  const merged = mergeWithDefaultKeybindings(serverKeybindings ?? []);
  return {
    commandOptions: buildKeybindingCommandOptions(merged, t),
    allRows: buildKeybindingRows(merged),
  };
}

export function KeybindingsSettingsPanel() {
  const t = useT();
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
  const rows = filterKeybindingRows(allRows, query, t);
  const groups = groupKeybindingRows(rows, t);
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
        title: t("settings.providers.keybindings.openFailed"),
        description:
          error instanceof Error ? error.message : t("settings.providers.keybindings.notOpened"),
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
          title: t("settings.providers.keybindings.saveFailed"),
          description:
            error instanceof Error ? error.message : t("settings.providers.keybindings.notSaved"),
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
          title: t("settings.providers.keybindings.removeFailed"),
          description:
            error instanceof Error ? error.message : t("settings.providers.keybindings.notRemoved"),
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

  const cancelAdd = () => setIsAddingBinding(false);

  const rowActions: KeybindingRowActions = {
    allRows,
    variables: whenVariables,
    onSave: saveKeybinding,
    onReset: resetKeybinding,
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
            {t("settings.providers.keybindings.add")}
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
                  aria-label={t("settings.providers.keybindings.openFile")}
                >
                  <FileJsonIcon aria-hidden className="size-4" />
                </Button>
              }
            />
            <TooltipPopup side="top">{t("settings.providers.keybindings.openFile")}</TooltipPopup>
          </Tooltip>
        </div>
      </SettingsSection>

      {!canWriteSettings ? (
        <p className="text-xs text-muted-foreground">
          {connectedEnvironments.length === 0
            ? t("settings.providers.keybindings.connect")
            : t("settings.providers.keybindings.viewOnly")}
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
              {t("settings.providers.keybindings.none")}
            </div>
          </SettingsGroup>
        )}
      </div>
    </SettingsPageContainer>
  );
}
