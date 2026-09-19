import { StorageCleanupPreviewPanel } from "./StorageCleanupPreview";
import type { StorageCleanupSettings, WorktreeCleanupRules } from "@t3tools/contracts";
import { resolveWorktreeCleanup } from "@t3tools/shared/projectSettings";
import { useState } from "react";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Button } from "../ui/button";
import { DaysNumberField } from "./DaysNumberField";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
import type { ScopedSettingsTarget } from "./scopedSettings";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  useClearScopedSettings,
  useScopedSettings,
  useUpdateScopedSettings,
} from "./useScopedSettings";

function RetentionControl({
  label,
  value,
  onChange,
  showOffLabel = true,
}: {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
  showOffLabel?: boolean;
}) {
  return (
    <div className="flex items-center gap-3">
      {value !== null ? (
        <DaysNumberField
          value={value}
          min={1}
          max={3650}
          label={`${label} in days`}
          onCommit={onChange}
        />
      ) : showOffLabel ? (
        <span className="text-xs text-muted-foreground">Off</span>
      ) : null}
      <Switch
        aria-label={label}
        checked={value !== null}
        onCheckedChange={(enabled) => onChange(enabled ? 8 : null)}
      />
    </div>
  );
}

export function StorageSettingsPanel() {
  const { search, targets } = useSettingsScope();
  // Drafts belong to an exact set of targets, including connection availability.
  const draftKey = JSON.stringify([
    search,
    targets.map(({ environmentId, projectId }) => [environmentId, projectId]),
  ]);
  return <StorageSettingsEditor key={draftKey} />;
}

function StorageSettingsEditor() {
  const { scope, connectedEnvironments, targets, target } = useSettingsScope();
  const scopedSettings = useScopedSettings();
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  const [draft, setDraft] = useState<Partial<StorageCleanupSettings>>({});
  const [draftMode, setDraftMode] = useState<"inherit" | "off" | "custom" | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const settings = {
    ...scopedSettings.storageCleanup,
    ...resolveWorktreeCleanup(scopedSettings, null),
    ...draft,
  };
  const projectMode = (entry: ScopedSettingsTarget | null) =>
    entry?.sources.worktreeCleanup === "project"
      ? (entry.settings.worktreeCleanup?.mode ?? "inherit")
      : "inherit";
  const mode = draftMode ?? projectMode(target);
  const mixedModes = draftMode === null && targets.some((entry) => projectMode(entry) !== mode);
  const updateSettings = useUpdateScopedSettings();
  const clearSettings = useClearScopedSettings();
  const ruleStatus = (key: keyof StorageCleanupSettings) =>
    !(key in draft) &&
    targets.some(
      (target) =>
        ({ ...target.settings.storageCleanup, ...resolveWorktreeCleanup(target.settings, null) })[
          key
        ] !== settings[key],
    )
      ? "Mixed across selected machines"
      : undefined;
  const update = (patch: Partial<StorageCleanupSettings>) => {
    setDraft((previous) => ({ ...previous, ...patch }));
    setSaveError(null);
  };
  const updateWorktree = (patch: Partial<WorktreeCleanupRules>) => update(patch);
  const changeMode = (next: "inherit" | "off" | "custom") => {
    setDraftMode(next);
    setDraft({});
    setSaveError(null);
  };
  const dirty = Object.keys(draft).length > 0 || draftMode !== null;
  const discard = () => {
    setDraft({});
    setDraftMode(null);
    setSaveError(null);
  };
  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const result = isProjectScope
        ? mode === "inherit"
          ? await clearSettings(["worktreeCleanup"])
          : await updateSettings({
              worktreeCleanup: mode === "off" ? { mode: "off" } : { mode: "custom", rules: draft },
            })
        : await updateSettings({ storageCleanup: draft });
      if (result && result.failedEnvironments.length === 0) discard();
      else
        setSaveError(
          "Some changes could not be saved. Your draft is retained; retry to apply it to the remaining machines.",
        );
    } catch {
      setSaveError("Changes could not be saved. Your draft is retained; try again.");
    } finally {
      setSaving(false);
    }
  };

  if (
    isProjectScope &&
    connectedEnvironments.some(
      (environment) =>
        environment.serverConfig?.environment.capabilities.projectWorktreeCleanup !== true,
    )
  ) {
    return (
      <SettingsScopeNotice target="all">
        Update the selected machines to configure project worktree cleanup.
      </SettingsScopeNotice>
    );
  }

  if (
    connectedEnvironments.some(
      (environment) => environment.serverConfig?.environment.capabilities.storageCleanup !== true,
    )
  ) {
    return (
      <SettingsScopeNotice
        target="environment"
        eligibleEnvironmentIds={connectedEnvironments
          .filter(
            (environment) =>
              environment.serverConfig?.environment.capabilities.storageCleanup === true,
          )
          .map((environment) => environment.environmentId)}
      >
        Update the selected environments to use storage cleanup, or choose a machine that supports
        it.
      </SettingsScopeNotice>
    );
  }

  return (
    <SettingsPageContainer>
      <div className="flex flex-col gap-8">
        <fieldset disabled={saving} className="flex min-w-0 flex-col gap-8">
          <SettingsSection id="storage-worktrees" title="Worktrees">
            {isProjectScope && (
              <SettingsRow
                title="Automatic worktree cleanup"
                description={
                  mode === "off"
                    ? "Keep this project's worktrees until you delete them manually."
                    : mode === "custom"
                      ? "Use these rules for this project."
                      : "Use each machine's worktree cleanup settings."
                }
                serverScoped
                settingKeys={["worktreeCleanup"]}
                mixed={mixedModes}
                onResetOverride={() => changeMode("inherit")}
                control={
                  <Select
                    value={mixedModes ? null : mode}
                    onValueChange={(next) => {
                      if (next === "inherit" || next === "off" || next === "custom")
                        changeMode(next);
                    }}
                  >
                    <SelectTrigger size="sm" aria-label="Automatic worktree cleanup">
                      <SelectValue>
                        {mixedModes
                          ? "Mixed"
                          : mode === "inherit"
                            ? "Inherit"
                            : mode === "off"
                              ? "Off"
                              : "Custom"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="end" alignItemWithTrigger={false}>
                      <SelectItem value="inherit">Inherit</SelectItem>
                      <SelectItem value="off">Off</SelectItem>
                      <SelectItem value="custom">Custom</SelectItem>
                    </SelectPopup>
                  </Select>
                }
              />
            )}
            <StorageCleanupPreviewPanel
              inactiveAfterDays={draft.worktreeAfterDays}
              mixedRules={{
                deleted: !!ruleStatus("worktreeOnDelete"),
                inactive: !!ruleStatus("worktreeAfterDays"),
                merged: !!ruleStatus("worktreeOnMerge"),
                unchanged: !!ruleStatus("worktreeUnchanged"),
              }}
              controls={
                !isProjectScope || (!mixedModes && mode === "custom")
                  ? {
                      deleted: (
                        <Switch
                          aria-label="Remove worktrees left by deleted threads"
                          checked={settings.worktreeOnDelete}
                          onCheckedChange={(worktreeOnDelete) =>
                            updateWorktree({ worktreeOnDelete })
                          }
                        />
                      ),
                      inactive: (
                        <RetentionControl
                          label="Remove inactive worktrees"
                          showOffLabel={false}
                          value={settings.worktreeAfterDays}
                          onChange={(worktreeAfterDays) => updateWorktree({ worktreeAfterDays })}
                        />
                      ),
                      merged: (
                        <Switch
                          aria-label="Remove merged worktrees"
                          checked={settings.worktreeOnMerge}
                          onCheckedChange={(worktreeOnMerge) => updateWorktree({ worktreeOnMerge })}
                        />
                      ),
                      unchanged: (
                        <Switch
                          aria-label="Remove worktrees with no unique commits"
                          checked={settings.worktreeUnchanged}
                          onCheckedChange={(worktreeUnchanged) =>
                            updateWorktree({ worktreeUnchanged })
                          }
                        />
                      ),
                    }
                  : undefined
              }
            />
          </SettingsSection>

          {!isProjectScope && (
            <SettingsSection id="storage-artifacts" title="Artifacts and logs">
              <SettingsRow
                title="Delete old browser artifacts"
                status={ruleStatus("browserArtifactsAfterDays")}
                description="Delete saved browser captures after this many days. Older capture links will no longer open."
                serverScoped
                control={
                  <RetentionControl
                    label="Delete old browser artifacts"
                    value={settings.browserArtifactsAfterDays}
                    onChange={(browserArtifactsAfterDays) => update({ browserArtifactsAfterDays })}
                  />
                }
              />
              <SettingsRow
                title="Delete old rotated logs"
                status={ruleStatus("logsAfterDays")}
                description="Delete inactive rotated log files after this many days. Current logs are kept."
                serverScoped
                control={
                  <RetentionControl
                    label="Delete old rotated logs"
                    value={settings.logsAfterDays}
                    onChange={(logsAfterDays) => update({ logsAfterDays })}
                  />
                }
              />
            </SettingsSection>
          )}
        </fieldset>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-4">
          <div className="text-xs text-muted-foreground" role="status">
            <p>
              {dirty
                ? "Unsaved changes. Cleanup can run as soon as you save."
                : "Changes only take effect after saving. Existing saved rules continue to run."}
            </p>
            {isProjectScope && <p>Applies to {scope.label}.</p>}
            {!isProjectScope && (
              <p>
                Applies to{" "}
                {connectedEnvironments.map((environment) => environment.label).join(", ") ||
                  "no connected machines"}
                .
              </p>
            )}
            {saveError && <p className="mt-1 text-destructive">{saveError}</p>}
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!dirty || saving}
              onClick={discard}
            >
              Discard
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!dirty || saving || targets.length === 0}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save cleanup rules"}
            </Button>
          </div>
        </div>
      </div>
    </SettingsPageContainer>
  );
}
