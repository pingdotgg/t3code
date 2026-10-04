import type { StorageCleanupSettings, WorktreeCleanupRules } from "@t3tools/contracts";
import { resolveWorktreeCleanup } from "@t3tools/shared/projectSettings";
import { useEffect, useRef, useState } from "react";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
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
}: {
  label: string;
  value: number | null;
  onChange: (value: number | null) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(value);
  const [savedValue, setSavedValue] = useState(value);
  // Local state from switching on until the saved value arrives: `days` is null while drafting,
  // then the age being saved. Every step gets a fresh token and only the open one may commit,
  // so stale callbacks (base-ui's blur, a held stepper released later) cannot save.
  const [session, setSession] = useState<{ token: object; days: number | null } | null>(null);
  const openRef = useRef<object | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const switchRef = useRef<HTMLElement>(null);
  if (savedValue !== value) {
    setSavedValue(value);
    setDraft(value);
    setSession(null);
  }
  const drafting = session?.days === null;

  useEffect(() => {
    if (!drafting) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [drafting]);
  // Unmounting closes the open session so base-ui callbacks that outlive the control cannot save.
  useEffect(
    () => () => {
      openRef.current = null;
    },
    [],
  );

  const open = (days: number | null) => {
    const token = {};
    openRef.current = token;
    setSession({ token, days });
    return token;
  };
  const close = () => {
    openRef.current = null;
    setSession(null);
  };

  // Saves a committed age. `null` reverts to the saved value, which cancels a draft.
  const commit = (next: number | null) => {
    if (session && openRef.current !== session.token) return;
    if (next === null) {
      // While saving, an emptied field shows the age being saved again; only the switch writes null.
      if (session?.days != null) return setDraft(session.days);
      close();
      return setDraft(value);
    }
    const days = Math.min(3650, Math.max(1, Math.round(next)));
    setDraft(days);
    const saved = onChange(days);
    if (!session) return;
    // Stay on with this age until the saved value arrives; fall back if nothing was saved.
    const token = open(days);
    void saved.then((ok) => {
      if (!ok && openRef.current === token) close();
    });
  };

  return (
    <div
      className="flex items-center gap-3"
      onBlur={(event) => {
        // Leaving the control without committing an age cancels the draft.
        if (drafting && !event.currentTarget.contains(event.relatedTarget)) commit(null);
      }}
      onKeyDown={(event) => {
        if (!drafting || event.key !== "Escape" || event.nativeEvent.isComposing) return;
        // Consume Escape so the settings page does not also navigate back.
        event.preventDefault();
        event.stopPropagation();
        close();
        switchRef.current?.focus();
      }}
    >
      {value !== null || session ? (
        <NumberField
          value={draft}
          min={1}
          max={3650}
          step={1}
          size="sm"
          className="w-auto"
          onValueChange={setDraft}
          onValueCommitted={commit}
        >
          <NumberFieldGroup>
            <NumberFieldDecrement aria-label={`Decrease ${label}`} />
            <NumberFieldInput
              ref={inputRef}
              aria-label={`${label} in days`}
              size={new Intl.NumberFormat().format(draft ?? value ?? 0).length}
              className="field-sizing-content w-auto min-w-[1ch] grow-0 text-right"
              onKeyDown={(event) => {
                if (!drafting || event.key !== "Enter" || event.nativeEvent.isComposing) return;
                // Moving focus lets base-ui commit typed text on blur; only text still showing
                // the draft (the untouched default) is committed here.
                const untouched =
                  draft !== null &&
                  event.currentTarget.value === new Intl.NumberFormat().format(draft);
                switchRef.current?.focus();
                if (untouched) commit(draft);
              }}
            />
            <span aria-hidden="true" className="self-center pr-2 text-xs">
              days
            </span>
            <NumberFieldIncrement aria-label={`Increase ${label}`} />
          </NumberFieldGroup>
        </NumberField>
      ) : (
        <span className="text-xs text-muted-foreground">Off</span>
      )}
      <Switch
        ref={switchRef}
        aria-label={label}
        checked={value !== null || session !== null}
        onCheckedChange={(enabled) => {
          if (enabled) {
            setDraft(8);
            open(null);
            return;
          }
          // A draft was never saved; anything past it needs a write to back it out.
          if (!drafting) void onChange(null);
          close();
          switchRef.current?.focus();
        }}
        // Clicking the switch off must not blur the input first: base-ui would commit typed text.
        onMouseDown={(event) => {
          if (drafting) event.preventDefault();
        }}
      />
    </div>
  );
}

export function StorageSettingsPanel() {
  const { scope, connectedEnvironments, targets, target } = useSettingsScope();
  const scopedSettings = useScopedSettings();
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  const settings = {
    ...scopedSettings.storageCleanup,
    ...resolveWorktreeCleanup(scopedSettings, null),
  };
  const projectMode = (entry: ScopedSettingsTarget | null) =>
    entry?.sources.worktreeCleanup === "project"
      ? (entry.settings.worktreeCleanup?.mode ?? "inherit")
      : "inherit";
  const mode = projectMode(target);
  const mixedModes = targets.some((entry) => projectMode(entry) !== mode);
  const updateSettings = useUpdateScopedSettings();
  const clearSettings = useClearScopedSettings();
  const ruleStatus = (key: keyof StorageCleanupSettings) =>
    targets.some(
      (target) =>
        ({ ...target.settings.storageCleanup, ...resolveWorktreeCleanup(target.settings, null) })[
          key
        ] !== settings[key],
    )
      ? "Mixed across selected machines"
      : undefined;
  const update = (patch: Partial<StorageCleanupSettings>) =>
    updateSettings({ storageCleanup: patch });
  const updateWorktree = (patch: Partial<WorktreeCleanupRules>) =>
    isProjectScope
      ? updateSettings({ worktreeCleanup: { mode: "custom", rules: patch } })
      : update(patch);

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
            control={
              <Select
                value={mixedModes ? null : mode}
                onValueChange={(next) => {
                  if (next === "inherit") clearSettings(["worktreeCleanup"]);
                  else if (next === "off") updateSettings({ worktreeCleanup: { mode: "off" } });
                  else if (next === "custom")
                    updateSettings({ worktreeCleanup: { mode: "custom", rules: {} } });
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
        {(!isProjectScope || (!mixedModes && mode === "custom")) && (
          <>
            <SettingsRow
              title="Delete worktrees with deleted threads"
              status={ruleStatus("worktreeOnDelete")}
              description="Remove unused worktrees when active or archived threads are deleted. Worktrees with local changes are kept."
              serverScoped={!isProjectScope}
              control={
                <Switch
                  aria-label="Delete worktrees with deleted threads"
                  checked={settings.worktreeOnDelete}
                  onCheckedChange={(worktreeOnDelete) => updateWorktree({ worktreeOnDelete })}
                />
              }
            />
            <SettingsRow
              title="Delete inactive worktrees"
              status={ruleStatus("worktreeAfterDays")}
              description="Remove worktrees after their threads have been inactive for this many days. Branches and thread history are kept."
              serverScoped={!isProjectScope}
              control={
                <RetentionControl
                  label="Delete inactive worktrees"
                  value={settings.worktreeAfterDays}
                  onChange={(worktreeAfterDays) => updateWorktree({ worktreeAfterDays })}
                />
              }
            />
            <SettingsRow
              title="Delete merged worktrees"
              status={ruleStatus("worktreeOnMerge")}
              description="Remove worktrees whose pull request is merged and whose commits are included in the default branch."
              serverScoped={!isProjectScope}
              control={
                <Switch
                  aria-label="Delete merged worktrees"
                  checked={settings.worktreeOnMerge}
                  onCheckedChange={(worktreeOnMerge) => updateWorktree({ worktreeOnMerge })}
                />
              }
            />
            <SettingsRow
              title="Delete unchanged worktrees"
              status={ruleStatus("worktreeUnchanged")}
              description="Remove worktrees with no commits beyond the default branch."
              serverScoped={!isProjectScope}
              control={
                <Switch
                  aria-label="Delete unchanged worktrees"
                  checked={settings.worktreeUnchanged}
                  onCheckedChange={(worktreeUnchanged) => updateWorktree({ worktreeUnchanged })}
                />
              }
            />
          </>
        )}
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
    </SettingsPageContainer>
  );
}
