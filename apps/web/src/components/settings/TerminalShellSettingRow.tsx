import type { TerminalShellSetting } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useEffect } from "react";

import { shellSettingLabel, shellSettingToSelectValue } from "../terminal/terminalShell.logic";
import { ShellOption } from "../terminal/NewTerminalShellMenu";
import { useTerminalShells } from "../terminal/useTerminalShells";
import { DiffFilePathCopyButton } from "../DiffFilePathCopyButton";
import { Button } from "../ui/button";
import { MiddleTruncate } from "../ui/middle-truncate";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

/**
 * Shells are detected on the server, so the list comes from the selected
 * environment; with several environments selected it is the first one's.
 */
export function TerminalShellSettingRow() {
  const { scope, target, connectedEnvironments } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["terminalShell"]);
  const { shells, status, load, canLoad } = useTerminalShells(target?.environmentId ?? null);
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  const unavailable = connectedEnvironments.length === 0;
  const effective = target
    ? resolveProjectSettings(target.settings, null, null, null).settings.terminalShell
    : null;
  const selectValue = mixed ? null : shellSettingToSelectValue(effective);
  const selectedProfile =
    !mixed && typeof effective === "string" && effective !== "auto"
      ? shells?.find((shell) => shell.id === effective)
      : undefined;

  // The trigger needs the list to show a profile's label; other values fetch when the select opens.
  const needsList = !mixed && typeof effective === "string" && effective !== "auto";
  useEffect(() => {
    if (needsList && status === "idle") void load();
  }, [needsList, status, load]);

  const save = (value: TerminalShellSetting | null) => updateSettings({ terminalShell: value });

  return (
    <SettingsRow
      serverScoped
      settingKeys={["terminalShell"]}
      mixed={mixed}
      {...searchableSetting("terminal-shell")}
      description={
        isProjectScope
          ? "Shell for new terminals in this project."
          : "Shell for new terminals. Projects can override it."
      }
      resetAction={
        !isProjectScope && settings.terminalShell !== null ? (
          <SettingResetButton label="default shell" onClick={() => save(null)} />
        ) : null
      }
      control={
        <Select
          value={selectValue}
          disabled={!canLoad}
          onOpenChange={(open) => {
            if (open) load();
          }}
          onValueChange={(value) => {
            if (value) save(value);
          }}
        >
          <SelectTrigger size="sm" aria-label="Default shell">
            <SelectValue>
              {(value: string | null) =>
                value === null
                  ? unavailable
                    ? "Unavailable"
                    : "Mixed"
                  : shellSettingLabel(value === "auto" ? null : value, shells)
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false} className="max-w-80">
            <SelectItem value="auto">Automatic</SelectItem>
            {(shells ?? []).map((shell) => (
              <SelectItem key={shell.id} value={shell.id}>
                <ShellOption label={shell.label} command={shell.command} />
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    >
      {status === "error" && canLoad ? (
        <div className="flex items-center gap-2 pb-2">
          <span className="text-xs text-muted-foreground">Could not load shells.</span>
          <Button variant="ghost" size="sm" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      ) : null}
      {selectedProfile ? (
        <div className="flex min-w-0 items-center gap-1 pb-2 font-mono text-xs text-muted-foreground @min-[32rem]/settings-row:max-w-xl">
          <MiddleTruncate value={selectedProfile.command} />
          <DiffFilePathCopyButton filePath={selectedProfile.command} />
        </div>
      ) : null}
    </SettingsRow>
  );
}
