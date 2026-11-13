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
import type { KeybindingRowActions } from "./KeybindingsSettings";
import { BrowserKeybindingNotice, KeybindingsGroups, KeybindingsSearchInput, NewKeybindingSettingsRow, keybindingAnchorIds, rowKeybindingTarget, useKeybindingCatalog } from "./KeybindingsSettings";

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
        title: "Unable to open keybindings file",
        description:
          error instanceof Error ? error.message : "The keybindings file was not opened.",
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
            Add keybinding
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
                  aria-label="Open keybindings.json"
                >
                  <FileJsonIcon aria-hidden className="size-4" />
                </Button>
              }
            />
            <TooltipPopup side="top">Open keybindings.json</TooltipPopup>
          </Tooltip>
        </div>
      </SettingsSection>

      {!canWriteSettings ? (
        <p className="text-xs text-muted-foreground">
          {connectedEnvironments.length === 0
            ? "Connect an environment to change keybindings."
            : "This connection can view keybindings but cannot change them."}
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
              No keybindings match your search.
            </div>
          </SettingsGroup>
        )}
      </div>
    </SettingsPageContainer>
  );
}

