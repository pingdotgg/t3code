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
import {
  KeybindingConflictWarning,
  WhenExpressionBuilder,
} from "./KeybindingsWhenExpression";
export * from "./KeybindingsWhenExpression";

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

export function KeybindingsSearchInput({
  query,
  onChange,
  inputRef,
}: {
  query: string;
  onChange: (next: string) => void;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
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
        placeholder="Search keybindings"
        aria-label="Search keybindings"
        size="sm"
      />
    </InputGroup>
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

export function rowKeybindingTarget(row: KeybindingRow): ServerRemoveKeybindingInput {
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
  const [draft, setDraft] = useReducer(keybindingRowDraftReducer, row, createKeybindingRowDraft);
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

export interface KeybindingRowActions {
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
          {isSaving ? "Saving" : "Save"}
        </Button>
      ) : null}
      {showPill ? (
        <button
          ref={pillRef}
          type="button"
          onClick={() => setDraft({ isRecording: true })}
          aria-label={`Edit shortcut for ${commandLabel(row.command)}: ${formatShortcutLabel(row.binding.shortcut)}`}
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
          aria-label={`Keybinding for ${commandLabel(row.command)}`}
          value={isRecording ? "" : keyDraft}
          placeholder={isRecording ? "Press shortcut" : "Unassigned"}
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
        aria-label={`Edit when clause for ${label}`}
      >
        <span className="truncate font-mono">{expression || "Always"}</span>
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
    <Badge variant="outline" size="sm">
      {source}
    </Badge>
  );
}

function KeybindingRowTitle({ row }: { row: KeybindingRow }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex items-center gap-2" />}>
        {commandLabel(row.command)}
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
  return (
    <span className="flex h-6 items-center gap-1.5">
      <span className="text-xs leading-none text-muted-foreground/70">When</span>
      <WhenClauseControl
        label={commandLabel(row.command)}
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
      <SelectTrigger size="sm" className={className}>
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

export function NewKeybindingSettingsRow(props: NewKeybindingProps) {
  const { commandOptions, allRows, variables, isSaving, onSave, onCancel } = props;
  const draft = useNewKeybindingDraft({ allRows, onSave });

  return (
    <SettingsRow
      className="bg-muted/15"
      title="New keybinding"
      description={
        <span className="flex h-6 items-center gap-1.5">
          <span className="text-xs leading-none text-muted-foreground/70">When</span>
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
            {isSaving ? "Saving" : "Save"}
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

export function KeybindingsGroups(props: KeybindingsGroupsProps) {
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

export function BrowserKeybindingNotice() {
  const message = "The browser may claim some shortcuts first. The desktop app receives them all.";
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

export function keybindingAnchorIds(rows: ReturnType<typeof buildKeybindingRows>) {
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
export function useKeybindingCatalog() {
  const serverKeybindings = useSettingsScope().environment?.serverConfig?.keybindings;
  const merged = mergeWithDefaultKeybindings(serverKeybindings ?? []);
  return {
    commandOptions: buildKeybindingCommandOptions(merged),
    allRows: buildKeybindingRows(merged),
  };
}
export * from "./KeybindingsSettingsParts";
