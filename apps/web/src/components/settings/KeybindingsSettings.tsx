import {
  ChevronDownIcon,
  CircleXIcon,
  EllipsisIcon,
  FileJsonIcon,
  InfoIcon,
  MinusIcon,
  PlusIcon,
  SearchIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  type KeybindingCommand,
  type KeybindingWhenNode,
  type ServerRemoveKeybindingInput,
  type ServerUpsertKeybindingInput,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { isElectron } from "../../env";
import {
  localizedPreferredEditorErrorMessage,
  useOpenInPreferredEditor,
} from "../../editorPreferences";
import { formatShortcutLabel } from "../../keybindings";
import { cn } from "../../lib/utils";
import {
  primaryServerAvailableEditorsAtom,
  primaryServerKeybindingsAtom,
  primaryServerKeybindingsConfigPathAtom,
  serverEnvironment,
} from "../../state/server";
import { usePrimaryEnvironment } from "../../state/environments";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Kbd, KbdGroup } from "../ui/kbd";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Toggle } from "../ui/toggle";
import { toastManager } from "../ui/toast";
import {
  buildKeybindingRows,
  buildKeybindingCommandOptions,
  buildWhenVariableOptions,
  localizedCommandLabel,
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
} from "./KeybindingsSettings.logic";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useAtomCommand } from "../../state/use-atom-command";
import { useI18n } from "../../i18n";

function KeybindingPill({ value }: { value: string }) {
  const parts = value.split("+");
  return (
    <KbdGroup className="bg-transparent p-0 shadow-none">
      {parts.map((part) => (
        <Kbd key={part} className="min-w-6 justify-center px-1.5">
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

function ExpandableHeaderSearch({
  query,
  onChange,
  isOpen,
  onOpenChange,
  inputRef,
  collapsedAccessory,
}: {
  query: string;
  onChange: (next: string) => void;
  isOpen: boolean;
  onOpenChange: (next: boolean) => void;
  inputRef?: RefObject<HTMLInputElement | null>;
  collapsedAccessory?: ReactNode;
}) {
  const { t } = useI18n();
  if (!isOpen) {
    return (
      <>
        {collapsedAccessory}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-micro"
                variant="ghost-muted"
                onClick={() => onOpenChange(true)}
                aria-label={t("keybindings.search")}
              >
                <SearchIcon className="size-3" />
              </Button>
            }
          />
          <TooltipPopup side="top">{t("keybindings.search")}</TooltipPopup>
        </Tooltip>
      </>
    );
  }

  return (
    <div className="relative">
      <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted-foreground" />
      <Input
        ref={inputRef}
        autoFocus
        type="search"
        value={query}
        onChange={(event) => onChange(event.currentTarget.value)}
        onBlur={() => {
          if (query.length === 0) onOpenChange(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onChange("");
            onOpenChange(false);
          }
        }}
        placeholder={t("keybindings.search")}
        aria-label={t("keybindings.search")}
        className="w-44 [&_[data-slot=input]]:pl-7"
        size="compact"
      />
    </div>
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

function UnknownWhenVariableWarning({
  identifiers,
  focusable = true,
}: {
  identifiers: ReadonlyArray<string>;
  focusable?: boolean;
}) {
  const { t } = useI18n();
  if (identifiers.length === 0) return null;
  const label =
    identifiers.length === 1
      ? t("keybindings.unknownOne", { conditions: identifiers[0] ?? "" })
      : t("keybindings.unknownMany", { conditions: identifiers.join(", ") });

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={focusable ? 0 : undefined}
            aria-label={label}
            className="inline-flex size-4.5 shrink-0 items-center justify-center rounded-sm text-warning outline-none transition-colors hover:bg-warning/10 focus-visible:ring-[3px] focus-visible:ring-warning/25"
          >
            <TriangleAlertIcon className="size-3.5" />
          </span>
        }
      />
      <TooltipPopup side="top" className="max-w-72 whitespace-normal leading-relaxed">
        {t("keybindings.unknownDescription")}
      </TooltipPopup>
    </Tooltip>
  );
}

function KeybindingConflictWarning({ labels }: { labels: ReadonlyArray<string> }) {
  const { t } = useI18n();
  if (labels.length === 0) return null;
  const description =
    labels.length === 1
      ? t("keybindings.conflictOne", { bindings: labels[0] ?? "" })
      : t("keybindings.conflictMany", {
          bindings: labels.slice(0, 3).join(", "),
          more: labels.length > 3 ? t("keybindings.conflictMore") : "",
        });

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            aria-label={description}
            className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-warning outline-none transition-colors hover:bg-warning/10 focus-visible:ring-[3px] focus-visible:ring-warning/25"
          >
            <TriangleAlertIcon className="size-3.5" />
          </span>
        }
      />
      <TooltipPopup side="top" className="max-w-72 whitespace-normal leading-relaxed">
        {t("keybindings.conflictDescription", { conflict: description })}
      </TooltipPopup>
    </Tooltip>
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
  const { t } = useI18n();
  const selected = variables.find((option) => option === value);
  const options =
    selected || variables.some((option) => option === value) ? variables : [value, ...variables];

  return (
    <Select value={value} onValueChange={(nextValue) => nextValue && onChange(nextValue)}>
      <SelectTrigger size="compact" className="min-w-0 flex-1 font-mono">
        <SelectValue placeholder={t("keybindings.condition")} className="leading-7" />
        {unknownIdentifiers && unknownIdentifiers.length > 0 ? (
          <UnknownWhenVariableWarning identifiers={unknownIdentifiers} focusable={false} />
        ) : null}
      </SelectTrigger>
      <SelectContent
        alignItemWithTrigger={false}
        matchTriggerWidth={false}
        popupClassName="w-fit"
        className="max-h-72 w-fit min-w-44"
      >
        {options.map((option) => (
          <SelectItem
            key={option}
            value={option}
            className="min-h-7 w-full py-1 font-mono text-[12px]"
          >
            <span className="truncate">{option}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
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
  const { t } = useI18n();
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
          aria-label={t("keybindings.negateCondition", { condition: condition.identifier })}
          variant="outline"
          size="compact"
          className="min-w-10"
        >
          {t("keybindings.not")}
        </Toggle>
        <WhenVariableSelect
          value={condition.identifier}
          variables={variables}
          unknownIdentifiers={unknownIdentifiers}
          onChange={(value) => onChange(setConditionIdentifier(node, value))}
        />
        {onRemove ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-7"
            aria-label={t("keybindings.removeCondition")}
            onClick={onRemove}
          >
            <MinusIcon className="size-3.5" />
          </Button>
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
            aria-label={t("keybindings.negateGroup")}
            variant="outline"
            size="compact"
            className="min-w-10"
          >
            {t("keybindings.not")}
          </Toggle>
          {onRemove ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="ml-auto size-7"
              aria-label={t("keybindings.removeNegatedGroup")}
              onClick={onRemove}
            >
              <MinusIcon className="size-3.5" />
            </Button>
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
          <SelectContent
            alignItemWithTrigger={false}
            matchTriggerWidth={false}
            popupClassName="w-fit"
            className="w-fit min-w-24"
          >
            <SelectItem value="and" className="min-h-7 py-1 font-mono text-[12px]">
              {t("keybindings.and")}
            </SelectItem>
            <SelectItem value="or" className="min-h-7 py-1 font-mono text-[12px]">
              {t("keybindings.or")}
            </SelectItem>
          </SelectContent>
        </Select>
        <Button type="button" variant="outline" size="compact" onClick={addCondition}>
          <PlusIcon className="size-3.5" />
          {t("keybindings.condition")}
        </Button>
        <Button type="button" variant="outline" size="compact" onClick={addGroup}>
          <PlusIcon className="size-3.5" />
          {t("keybindings.group")}
        </Button>
        {onRemove ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="ml-auto size-7"
            aria-label={t("keybindings.removeGroup")}
            onClick={onRemove}
          >
            <MinusIcon className="size-3.5" />
          </Button>
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
  const { t } = useI18n();
  const expression = whenAstToExpression(value);
  const [expressionDraft, setExpressionDraft] = useState(expression);
  const parseResult = useMemo(
    () => parseWhenExpressionDraft(expressionDraft, t),
    [expressionDraft, t],
  );
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
          <div className="text-sm font-medium text-foreground">{t("keybindings.when")}</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button type="button" variant="outline" size="compact" onClick={addRootCondition}>
            <PlusIcon className="size-3.5" />
            {t("keybindings.condition")}
          </Button>
          <Button type="button" variant="outline" size="compact" onClick={addRootGroup}>
            <PlusIcon className="size-3.5" />
            {t("keybindings.group")}
          </Button>
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="relative">
          <Input
            value={expressionDraft}
            onChange={(event) => updateExpressionDraft(event.currentTarget.value)}
            placeholder={t("keybindings.always")}
            aria-invalid={Boolean(parseError)}
            aria-label={t("keybindings.whenExpression")}
            className={cn(
              "h-7 rounded-md font-mono text-[12px] leading-7 sm:h-7 sm:leading-7",
              unknownIdentifiers.length > 0 && "pr-9",
              parseError && "border-destructive/70 focus-visible:border-destructive",
            )}
          />
          {unknownIdentifiers.length > 0 ? (
            <span className="absolute inset-y-0 right-2 flex items-center">
              <UnknownWhenVariableWarning identifiers={unknownIdentifiers} />
            </span>
          ) : null}
        </div>
        {parseError ? (
          <div className="flex items-center gap-1.5 text-[11px] text-destructive">
            <CircleXIcon className="size-3.5" />
            {t("keybindings.invalidExpression")}
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
                {t("keybindings.condition")}
              </Button>
              <Button type="button" variant="outline" size="compact" onClick={addRootGroup}>
                <PlusIcon className="size-3.5" />
                {t("keybindings.group")}
              </Button>
            </div>
          </div>
        )}
        {parseError ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg border border-destructive/30 bg-background/75 p-4 text-center text-xs text-destructive backdrop-blur-[1px]">
            {t("keybindings.fixExpression")}
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

function KeybindingTableRow({
  row,
  allRows,
  variables,
  isSaving,
  onSave,
  onReset,
  onRemove,
}: {
  row: KeybindingRow;
  allRows: ReadonlyArray<KeybindingRow>;
  variables: ReadonlyArray<WhenVariableOption>;
  isSaving: boolean;
  onSave: (input: ServerUpsertKeybindingInput) => void;
  onReset: (row: KeybindingRow) => void;
  onRemove: (row: KeybindingRow) => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useReducer(keybindingRowDraftReducer, row, createKeybindingRowDraft);
  const { keyDraft, whenDraft, isRecording, isWhenDraftValid } = draft;
  const whenDraftExpression = whenAstToExpression(whenDraft);
  const isDirty = keyDraft !== row.key || whenDraftExpression !== row.when;
  const displayShortcut = formatShortcutLabel(row.binding.shortcut);
  const canReset = row.source === "Custom" && row.defaultKey !== null;
  const canRemove = row.source !== "Default";
  const hasRowActions = canReset || canRemove;
  const showPill = !isRecording && keyDraft === row.key && row.key.length > 0 && !isDirty;
  const conflictLabels = keybindingConflictLabels(allRows, {
    rowId: row.id,
    key: keyDraft,
    when: whenDraftExpression,
  });
  const commandLabelText = localizedCommandLabel(row.command, t);

  const save = () => {
    onSave({
      command: row.command,
      key: keyDraft,
      when: whenDraftExpression.trim().length > 0 ? whenDraftExpression : undefined,
      replace: rowKeybindingTarget(row),
    });
  };

  const captureKeybinding = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Tab") return;
    event.preventDefault();
    if (event.key === "Escape") {
      setDraft({ keyDraft: row.key, isRecording: false });
      return;
    }
    const next = keybindingFromKeyboardEvent(event.nativeEvent, navigator.platform);
    if (!next) return;
    setDraft({ keyDraft: next, isRecording: false });
  };

  return (
    <div className="grid grid-cols-[minmax(190px,1.1fr)_minmax(220px,0.85fr)_minmax(210px,1fr)_60px] items-center px-4 py-1.5 text-sm even:bg-muted/15 hover:bg-accent/40">
      <div className="min-w-0 pr-4">
        <div className="flex min-w-0 items-center gap-1.5">
          <Tooltip>
            <TooltipTrigger
              render={
                <div
                  aria-label={row.command}
                  className="truncate text-[13px] font-medium text-foreground"
                />
              }
            >
              {commandLabelText}
            </TooltipTrigger>
            <TooltipPopup side="top">{row.command}</TooltipPopup>
          </Tooltip>
        </div>
      </div>
      <div className="flex min-w-0 items-center gap-2 pr-4">
        {showPill ? (
          <button
            type="button"
            onClick={() => setDraft({ isRecording: true })}
            aria-label={t("keybindings.editShortcut", { command: commandLabelText })}
            className="group inline-flex h-7 items-center gap-1.5 rounded-md border border-transparent px-1.5 outline-none transition-colors hover:border-border/70 hover:bg-background focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/24"
          >
            <KeybindingPill value={row.key} />
            <span className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground/0 transition-opacity group-hover:text-muted-foreground/70 group-focus-visible:text-muted-foreground/70">
              {t("keybindings.edit")}
            </span>
          </button>
        ) : (
          <Input
            data-keybinding-capture=""
            autoFocus={isRecording}
            aria-label={t("keybindings.bindingFor", { command: commandLabelText })}
            value={isRecording ? "" : keyDraft}
            placeholder={isRecording ? t("keybindings.pressShortcut") : t("keybindings.unassigned")}
            className={cn(
              "h-7 w-44 rounded-md font-mono text-[12px] sm:h-7",
              isRecording && "border-primary/70 bg-primary/5",
            )}
            onFocus={() => setDraft({ isRecording: true })}
            onBlur={() => setDraft({ isRecording: false })}
            onChange={(event) => setDraft({ keyDraft: event.currentTarget.value })}
            onKeyDown={captureKeybinding}
          />
        )}
        {isDirty ? (
          <Button
            size="compact"
            disabled={isSaving || keyDraft.trim().length === 0 || !isWhenDraftValid}
            onClick={save}
          >
            {isSaving ? t("keybindings.saving") : t("common.save")}
          </Button>
        ) : null}
      </div>
      <div className="pr-4">
        <Popover>
          <PopoverTrigger
            className={cn(
              "inline-flex h-7 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-2.5 text-left font-mono text-[12px] text-foreground shadow-xs/5 outline-none transition-colors hover:bg-accent focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/24",
              !whenDraftExpression && "text-muted-foreground",
            )}
            aria-label={t("keybindings.editWhen", { command: commandLabelText })}
          >
            <span className="truncate">{whenDraftExpression || t("keybindings.always")}</span>
            <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" />
          </PopoverTrigger>
          <PopoverContent align="start" sideOffset={6}>
            <WhenExpressionBuilder
              value={whenDraft}
              variables={variables}
              onChange={(nextWhenDraft) => setDraft({ whenDraft: nextWhenDraft })}
              onValidityChange={(nextIsValid) => setDraft({ isWhenDraftValid: nextIsValid })}
            />
          </PopoverContent>
        </Popover>
      </div>
      <div className="flex items-center justify-end gap-1">
        <KeybindingConflictWarning labels={conflictLabels} />
        {hasRowActions ? (
          <Menu>
            <MenuTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="size-7 text-muted-foreground hover:text-foreground sm:size-7"
                  disabled={isSaving}
                  aria-label={t("keybindings.actions", { command: commandLabelText })}
                />
              }
            >
              <EllipsisIcon className="size-3.5" />
            </MenuTrigger>
            <MenuPopup align="end" className="min-w-36">
              {canReset ? (
                <MenuItem disabled={isSaving} onClick={() => onReset(row)}>
                  {t("keybindings.reset")}
                </MenuItem>
              ) : null}
              {canRemove ? (
                <MenuItem variant="destructive" disabled={isSaving} onClick={() => onRemove(row)}>
                  {t("keybindings.remove")}
                </MenuItem>
              ) : null}
            </MenuPopup>
          </Menu>
        ) : null}
        <span className="sr-only">{displayShortcut}</span>
      </div>
    </div>
  );
}

function NewKeybindingTableRow({
  commandOptions,
  allRows,
  variables,
  isSaving,
  onSave,
  onCancel,
}: {
  commandOptions: ReadonlyArray<KeybindingCommandOption>;
  allRows: ReadonlyArray<KeybindingRow>;
  variables: ReadonlyArray<WhenVariableOption>;
  isSaving: boolean;
  onSave: (input: ServerUpsertKeybindingInput) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
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
  const commandLabelText = commandDraft
    ? localizedCommandLabel(commandDraft, t)
    : t("keybindings.new");

  const save = () => {
    if (!commandDraft) return;
    onSave({
      command: commandDraft,
      key: keyDraft,
      ...(whenDraftExpression.trim().length > 0 ? { when: whenDraftExpression } : {}),
    });
  };

  const captureKeybinding = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Tab") return;
    event.preventDefault();
    if (event.key === "Escape") {
      setDraft({ keyDraft: "", isRecording: false });
      return;
    }
    const next = keybindingFromKeyboardEvent(event.nativeEvent, navigator.platform);
    if (!next) return;
    setDraft({ keyDraft: next, isRecording: false });
  };

  return (
    <div className="grid grid-cols-[minmax(190px,1.1fr)_minmax(220px,0.85fr)_minmax(210px,1fr)_60px] items-center px-4 py-1.5 text-sm even:bg-muted/15 hover:bg-accent/40">
      <div className="min-w-0 pr-4">
        <Select
          value={commandDraft}
          onValueChange={(value) => setCommandDraft(value as KeybindingCommand)}
        >
          <SelectTrigger size="compact" className="w-full max-w-60">
            <SelectValue placeholder={t("keybindings.command")} />
          </SelectTrigger>
          <SelectContent
            alignItemWithTrigger={false}
            matchTriggerWidth={false}
            className="max-h-72 w-fit min-w-56"
          >
            {commandOptions.map((command) => (
              <SelectItem key={command} value={command} className="min-h-7 w-full py-1 text-[12px]">
                <span className="truncate">{localizedCommandLabel(command, t)}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex min-w-0 items-center gap-2 pr-4">
        <Input
          data-keybinding-capture=""
          aria-label={t("keybindings.bindingFor", { command: commandLabelText })}
          value={isRecording ? "" : keyDraft}
          placeholder={isRecording ? t("keybindings.pressShortcut") : t("keybindings.unassigned")}
          size="compact"
          className={cn("w-44 font-mono", isRecording && "border-primary/70 bg-primary/5")}
          onFocus={() => setDraft({ isRecording: true })}
          onBlur={() => setDraft({ isRecording: false })}
          onChange={(event) => setDraft({ keyDraft: event.currentTarget.value })}
          onKeyDown={captureKeybinding}
        />
        <Button
          size="compact"
          disabled={isSaving || !commandDraft || keyDraft.trim().length === 0 || !isWhenDraftValid}
          onClick={save}
        >
          {isSaving ? t("keybindings.saving") : t("common.save")}
        </Button>
      </div>
      <div className="pr-4">
        <Popover>
          <PopoverTrigger
            className={cn(
              "inline-flex h-7 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-2.5 text-left font-mono text-[12px] text-foreground shadow-xs/5 outline-none transition-colors hover:bg-accent focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/24",
              !whenDraftExpression && "text-muted-foreground",
            )}
            aria-label={t("keybindings.editWhen", { command: commandLabelText })}
          >
            <span className="truncate">{whenDraftExpression || t("keybindings.always")}</span>
            <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" />
          </PopoverTrigger>
          <PopoverContent align="start" sideOffset={6}>
            <WhenExpressionBuilder
              value={whenDraft}
              variables={variables}
              onChange={(nextWhenDraft) => setDraft({ whenDraft: nextWhenDraft })}
              onValidityChange={(nextIsValid) => setDraft({ isWhenDraftValid: nextIsValid })}
            />
          </PopoverContent>
        </Popover>
      </div>
      <div className="flex items-center justify-end gap-1">
        <KeybindingConflictWarning labels={conflictLabels} />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="size-7 text-muted-foreground hover:text-foreground"
                disabled={isSaving}
                aria-label={t("keybindings.cancelNew")}
                onClick={onCancel}
              />
            }
          >
            <XIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">{t("common.cancel")}</TooltipPopup>
        </Tooltip>
      </div>
    </div>
  );
}

export function KeybindingsSettingsPanel() {
  const { t } = useI18n();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const keybindingsConfigPath = useAtomValue(primaryServerKeybindingsConfigPathAtom);
  const availableEditors = useAtomValue(primaryServerAvailableEditorsAtom);
  const primaryEnvironment = usePrimaryEnvironment();
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
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [savingCommand, setSavingCommand] = useState<KeybindingCommand | null>(null);
  const [isAddingBinding, setIsAddingBinding] = useState(false);
  const rows = useMemo(() => buildKeybindingRows(keybindings, query), [keybindings, query]);
  const commandOptions = useMemo(() => buildKeybindingCommandOptions(keybindings), [keybindings]);
  const whenVariables = useMemo(() => buildWhenVariableOptions(), []);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      const isMod = event.metaKey || event.ctrlKey;
      if (!isMod || event.altKey || event.key.toLowerCase() !== "f") return;

      const target = event.target;
      if (
        target !== searchInputRef.current &&
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return;
      }

      event.preventDefault();
      setIsSearchOpen(true);
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const openKeybindingsFile = useCallback(() => {
    if (!keybindingsConfigPath) return;
    void (async () => {
      const result = await openInPreferredEditor(keybindingsConfigPath);
      if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
        return;
      }
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        title: t("keybindings.openFailed"),
        description: localizedPreferredEditorErrorMessage(error, t),
        type: "error",
      });
    })();
  }, [keybindingsConfigPath, openInPreferredEditor, t]);

  const saveKeybinding = useCallback(
    (input: ServerUpsertKeybindingInput) => {
      if (!primaryEnvironment) return;
      setSavingCommand(input.command);
      const payload: ServerUpsertKeybindingInput = {
        command: input.command,
        key: input.key.trim(),
        ...(input.when?.trim() ? { when: input.when.trim() } : {}),
        ...(input.replace ? { replace: input.replace } : {}),
      };
      void (async () => {
        const result = await upsertKeybinding({
          environmentId: primaryEnvironment.environmentId,
          input: payload,
        });
        setSavingCommand(null);
        if (result._tag === "Success") {
          setIsAddingBinding(false);
          return;
        }
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add({
            title: t("keybindings.saveFailed"),
            description:
              error instanceof Error ? error.message : t("keybindings.saveFailedDescription"),
            type: "error",
          });
        }
      })();
    },
    [primaryEnvironment, t, upsertKeybinding],
  );

  const removeKeybinding = useCallback(
    (row: KeybindingRow) => {
      if (!primaryEnvironment) return;
      setSavingCommand(row.command);
      void (async () => {
        const result = await removeKeybindingMutation({
          environmentId: primaryEnvironment.environmentId,
          input: rowKeybindingTarget(row),
        });
        setSavingCommand(null);
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add({
            title: t("keybindings.removeFailed"),
            description:
              error instanceof Error ? error.message : t("keybindings.removeFailedDescription"),
            type: "error",
          });
        }
      })();
    },
    [primaryEnvironment, removeKeybindingMutation, t],
  );

  const resetKeybinding = useCallback(
    (row: KeybindingRow) => {
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
    },
    [saveKeybinding],
  );

  const bindingCount = rows.length + (isAddingBinding ? 1 : 0);
  const bindingsCount = (
    <span className="text-[11px] text-muted-foreground">
      {t(bindingCount === 1 ? "keybindings.countOne" : "keybindings.countMany", {
        count: bindingCount,
      })}
    </span>
  );

  return (
    <SettingsPageContainer width="wide">
      <SettingsSection
        {...searchableSetting("keybindings", t)}
        title={t("keybindings.title")}
        headerAction={
          <div className="flex items-center gap-1.5">
            <ExpandableHeaderSearch
              query={query}
              onChange={setQuery}
              isOpen={isSearchOpen}
              onOpenChange={setIsSearchOpen}
              inputRef={searchInputRef}
              collapsedAccessory={bindingsCount}
            />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-micro"
                    variant="ghost-muted"
                    onClick={() => setIsAddingBinding(true)}
                    aria-label={t("keybindings.add")}
                  >
                    <PlusIcon className="size-3" />
                  </Button>
                }
              />
              <TooltipPopup side="top">{t("keybindings.add")}</TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-micro"
                    variant="ghost-muted"
                    disabled={!keybindingsConfigPath}
                    onClick={openKeybindingsFile}
                    aria-label={t("keybindings.openFile")}
                  >
                    <FileJsonIcon className="size-3" />
                  </Button>
                }
              />
              <TooltipPopup side="top">{t("keybindings.openFile")}</TooltipPopup>
            </Tooltip>
          </div>
        }
      >
        {!isElectron ? (
          <div className="flex items-start gap-2 border-b border-warning/20 bg-warning/5 px-3 py-2.5 text-[12px] leading-relaxed text-muted-foreground sm:px-4">
            <InfoIcon className="mt-0.5 size-3.5 shrink-0 text-warning" />
            <p>{t("keybindings.browserWarning")}</p>
          </div>
        ) : null}

        <ScrollArea
          chainVerticalScroll
          scrollFade
          hideScrollbars
          className="w-full max-w-full rounded-none"
        >
          <div className="grid min-w-[680px] grid-cols-[minmax(190px,1.1fr)_minmax(220px,0.85fr)_minmax(210px,1fr)_60px] border-b border-border/70 bg-muted/25 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
            <div>{t("keybindings.command")}</div>
            <div>{t("keybindings.keybinding")}</div>
            <div>{t("keybindings.when")}</div>
            <div>{t("keybindings.status")}</div>
          </div>
          <div className="min-w-[680px] divide-y divide-border/60">
            {isAddingBinding ? (
              <NewKeybindingTableRow
                commandOptions={commandOptions}
                allRows={rows}
                variables={whenVariables}
                isSaving={savingCommand !== null}
                onSave={saveKeybinding}
                onCancel={() => setIsAddingBinding(false)}
              />
            ) : null}
            {rows.map((row) => (
              <KeybindingTableRow
                key={row.id}
                row={row}
                allRows={rows}
                variables={whenVariables}
                isSaving={savingCommand === row.command}
                onSave={saveKeybinding}
                onReset={resetKeybinding}
                onRemove={removeKeybinding}
              />
            ))}
            {rows.length === 0 && !isAddingBinding ? (
              <div className="px-4 py-12 text-center text-sm text-muted-foreground">
                {t("keybindings.noResults")}
              </div>
            ) : null}
          </div>
        </ScrollArea>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
