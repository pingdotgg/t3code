import { SearchIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ensureLocalApi } from "../../localApi";
import { resolveAndPersistPreferredEditor } from "../../editorPreferences";
import { formatShortcutLabel } from "../../keybindings";
import { reportClientWarning } from "../../lib/clientLogger";
import {
  useServerAvailableEditors,
  useServerConfig,
  useServerKeybindings,
  useServerKeybindingsConfigPath,
} from "../../rpc/serverState";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Kbd } from "../ui/kbd";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  buildKeybindingRows,
  buildReplacementRules,
  defaultRulesForCommand,
  filterKeybindingRows,
  keybindingFromKeyboardEvent,
  type KeybindingRow,
} from "./KeybindingsSettings.logic";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";

function describeRow(row: KeybindingRow): string {
  const condition = row.when.length > 0 ? `Only when ${row.when}` : "Always active";
  return row.source === "Default" ? condition : `${condition} · Customized`;
}

function KeybindingRowControl({
  row,
  isEditing,
  isSaving,
  pendingKey,
  onStartEdit,
  onSave,
  onCancel,
  onReset,
}: {
  row: KeybindingRow;
  isEditing: boolean;
  isSaving: boolean;
  pendingKey: string | null;
  onStartEdit: () => void;
  onSave: () => void;
  onCancel: () => void;
  onReset: () => void;
}) {
  const canReset = row.isCustomized && defaultRulesForCommand(row.command).length > 0;
  if (!isEditing) {
    return (
      <>
        <Kbd aria-label={`Current shortcut for ${row.label}`}>
          {formatShortcutLabel(row.shortcut)}
        </Kbd>
        <Button size="xs" variant="outline" disabled={isSaving} onClick={onStartEdit}>
          Edit
        </Button>
        {canReset ? <SettingResetButton label={`${row.label} shortcut`} onClick={onReset} /> : null}
      </>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Kbd aria-live="polite">{pendingKey ?? "Press shortcut…"}</Kbd>
      <Button size="xs" variant="default" disabled={isSaving || !pendingKey} onClick={onSave}>
        {isSaving ? "Saving…" : "Save"}
      </Button>
      <Button size="xs" variant="ghost" disabled={isSaving} onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

export function KeybindingsSettingsPanel() {
  const keybindings = useServerKeybindings();
  const keybindingsConfigPath = useServerKeybindingsConfigPath();
  const availableEditors = useServerAvailableEditors();
  const serverConfig = useServerConfig();
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [isOpeningFile, setIsOpeningFile] = useState(false);
  const [openFileError, setOpenFileError] = useState<string | null>(null);

  const rows = useMemo(() => buildKeybindingRows(keybindings), [keybindings]);
  const visibleRows = useMemo(() => filterKeybindingRows(rows, query), [rows, query]);
  const editingRow = editingId ? (rows.find((row) => row.id === editingId) ?? null) : null;
  const issues = useMemo(
    () => (serverConfig?.issues ?? []).filter((issue) => issue.kind.startsWith("keybindings.")),
    [serverConfig],
  );

  useEffect(() => {
    if (editingId && !rows.some((row) => row.id === editingId)) {
      setEditingId(null);
      setPendingKey(null);
    }
  }, [editingId, rows]);

  useEffect(() => {
    if (!editingRow) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setEditingId(null);
        setPendingKey(null);
        return;
      }
      const next = keybindingFromKeyboardEvent(event, navigator.platform);
      if (!next) return;
      event.preventDefault();
      event.stopPropagation();
      setPendingKey(next);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [editingRow]);

  const saveRow = useCallback(
    async (row: KeybindingRow, key: string) => {
      // Row-level replacement: the edited row takes the new key while every
      // sibling row of the same command is preserved. The command-wide
      // single-rule upsert would silently delete those siblings.
      const rules = buildReplacementRules(rows, row, key);
      setSavingId(row.id);
      try {
        await ensureLocalApi().server.replaceKeybindingRules({
          command: row.command,
          rules,
        });
        setEditingId(null);
        setPendingKey(null);
      } catch (error) {
        reportClientWarning("Failed to save keybinding", error);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Could not save shortcut for ${row.label}`,
            description: error instanceof Error ? error.message : "Saving failed.",
          }),
        );
      } finally {
        setSavingId(null);
      }
    },
    [rows],
  );

  const resetRow = useCallback((row: KeybindingRow) => {
    // Removing the command override restores its complete default rule set
    // (keys and conditions); re-upserting a single default would keep a
    // customized condition and drop the other defaults.
    void ensureLocalApi()
      .server.replaceKeybindingRules({ command: row.command, rules: [] })
      .catch((error: unknown) => {
        reportClientWarning("Failed to reset keybinding", error);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Could not reset shortcut for ${row.label}`,
            description: error instanceof Error ? error.message : "Reset failed.",
          }),
        );
      });
  }, []);

  const openKeybindingsFile = useCallback(() => {
    if (!keybindingsConfigPath || isOpeningFile) return;
    setOpenFileError(null);
    setIsOpeningFile(true);
    const editor = resolveAndPersistPreferredEditor(availableEditors ?? []);
    if (!editor) {
      setOpenFileError("No available editors found.");
      setIsOpeningFile(false);
      return;
    }
    void ensureLocalApi()
      .shell.openInEditor(keybindingsConfigPath, editor)
      .catch((error: unknown) => {
        setOpenFileError(
          error instanceof Error ? error.message : "Unable to open keybindings file.",
        );
      })
      .finally(() => {
        setIsOpeningFile(false);
      });
  }, [availableEditors, isOpeningFile, keybindingsConfigPath]);

  return (
    <SettingsPageContainer width="wide">
      <SettingsPageHeader
        title="Keybindings"
        description="View and change keyboard shortcuts. Edits are saved to keybindings.json; the most recent matching binding wins."
      />

      {issues.length > 0 ? (
        <div
          role="alert"
          className="rounded-2xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-xs leading-relaxed text-foreground"
        >
          <span className="font-semibold">
            {issues.length === 1
              ? "There is a problem with keybindings.json."
              : `There are ${issues.length} problems with keybindings.json.`}{" "}
          </span>
          <span className="text-muted-foreground">{issues[0]?.message}</span>
        </div>
      ) : null}

      <SettingsSection
        title="Shortcuts"
        description={`${visibleRows.length} of ${rows.length} bindings`}
        headerAction={
          <div className="relative">
            <SearchIcon
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              size="sm"
              type="search"
              className="w-44 pl-7"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search keybindings"
              aria-label="Search keybindings"
            />
          </div>
        }
      >
        {visibleRows.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-muted-foreground sm:px-5">
            {rows.length === 0 ? "No keybindings reported by the server yet." : "No matches."}
          </div>
        ) : (
          visibleRows.map((row) => (
            <SettingsRow
              key={row.id}
              title={row.label}
              description={describeRow(row)}
              status={
                row.conflicts.length > 0 ? (
                  <span className="block text-warning">
                    Also triggers {row.conflicts.join(", ")}. The most recent match wins.
                  </span>
                ) : null
              }
              control={
                <KeybindingRowControl
                  row={row}
                  isEditing={editingId === row.id}
                  isSaving={savingId === row.id}
                  pendingKey={editingId === row.id ? pendingKey : null}
                  onStartEdit={() => {
                    setEditingId(row.id);
                    setPendingKey(null);
                  }}
                  onSave={() => {
                    if (pendingKey) void saveRow(row, pendingKey);
                  }}
                  onCancel={() => {
                    setEditingId(null);
                    setPendingKey(null);
                  }}
                  onReset={() => resetRow(row)}
                />
              }
            />
          ))
        )}
      </SettingsSection>

      <SettingsSection title="Advanced">
        <SettingsRow
          title="Keybindings file"
          description="Open the persisted keybindings.json file to edit advanced bindings directly."
          status={
            <>
              <span className="block break-all font-mono text-[11px] text-foreground">
                {keybindingsConfigPath ?? "Resolving keybindings path..."}
              </span>
              {openFileError ? (
                <span className="mt-1 block text-destructive">{openFileError}</span>
              ) : (
                <span className="mt-1 block">Opens in your preferred editor.</span>
              )}
            </>
          }
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={!keybindingsConfigPath || isOpeningFile}
              onClick={openKeybindingsFile}
            >
              {isOpeningFile ? "Opening..." : "Open file"}
            </Button>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
