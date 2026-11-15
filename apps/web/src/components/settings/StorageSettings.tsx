import type {
  StorageCleanupReport,
  StorageCleanupSettings,
  WorktreeCleanupRules,
} from "@t3tools/contracts";
import { resolvePastedPath } from "@t3tools/shared/path";
import { resolveWorktreeCleanup } from "@t3tools/shared/projectSettings";
import { useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { formatBytes } from "../../lib/formatBytes";
import { environmentAtomList, environmentIdsKey } from "../../state/environmentAtomList";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useDebouncedValue } from "../../state/queries";
import { AnimatedHeight } from "../AnimatedHeight";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { DatabaseStorageNotice } from "./DatabaseStorageNotice";
import { AdvancedSettings } from "./AdvancedSettings";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
import { SettingsGroup } from "./SettingsGroup";
import type { ScopedSettingsTarget } from "./scopedSettings";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import {
  useClearScopedSettings,
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";
import { settingsScopeEnvironmentLabel } from "./settingsScopeAxis";
import { useTranslation } from "react-i18next";
import { translateDynamic } from "../../i18nCore";

export function WorktreesDirectoryRow() {
  const { connectedEnvironments, targets } = useSettingsScope();
  const { t } = useTranslation("settings");
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["worktreesDirectory"]);
  const edited = useRef(false);
  const draft = useRef("");
  if (
    connectedEnvironments.some(
      (environment) =>
        environment.serverConfig?.environment.capabilities.worktreesDirectory !== true,
    )
  )
    return null;
  const scopeKey = targets.map((target) => target.environmentId).join(",");

  return (
    <SettingsRow
      {...searchableSetting("storage-worktrees-location")}
      description={t("storage.worktreesDirectoryDescription")}
      serverScoped
      settingKeys={["worktreesDirectory"]}
      resetAction={
        mixed || settings.worktreesDirectory !== "" ? (
          <SettingResetButton
            label={t("storage.resetWorktreeLocation")}
            onClick={() => updateSettings({ worktreesDirectory: "" })}
          />
        ) : null
      }
      control={
        <Input
          key={`${scopeKey}:${mixed}:${settings.worktreesDirectory}`}
          aria-label={t("storage.worktreeLocation")}
          autoCapitalize="none"
          spellCheck={false}
          placeholder={mixed ? t("storage.mixed") : t("storage.default")}
          defaultValue={mixed ? "" : settings.worktreesDirectory}
          onFocus={(event) => {
            draft.current = event.target.value;
          }}
          onChange={(event) => {
            edited.current = true;
            draft.current = resolvePastedPath(draft.current, event.target.value);
            event.target.value = draft.current;
          }}
          onBlur={(event) => {
            const value = event.target.value.trim();
            if (edited.current && (mixed || value !== settings.worktreesDirectory))
              updateSettings({ worktreesDirectory: value });
            edited.current = false;
          }}
        />
      }
    />
  );
}

type SaveOptions = Parameters<ReturnType<typeof useUpdateScopedSettings>>[1];

function RetentionControl({
  label,
  value,
  onChange,
  minimum = 1,
}: {
  label: string;
  value: number | null;
  onChange: (value: number | null, onFailed: () => void) => void;
  minimum?: number;
}) {
  const [draft, setDraft] = useState(value);
  const [savedValue, setSavedValue] = useState(value);
  // Saving an age can start a cleanup sweep, so turning a rule on only opens a draft.
  // While its first save is in flight this holds that submission.
  const [enabling, setEnabling] = useState<"draft" | "edited" | { days: number } | null>(null);
  // Holds an age until Enter or focus leaves the row: one edited before focus moved to the
  // switch, so switching off never saves it first, or one stepped toward a rule's first age,
  // so raising it from 8 never saves a shorter age on the way.
  const [held, setHeld] = useState(false);
  // Hides a saved rule's age once it is switched off, so no blur can save it after null.
  const [switchedOff, setSwitchedOff] = useState(false);
  const { t } = useTranslation("settings");
  if (savedValue !== value) {
    setSavedValue(value);
    setDraft(value);
    setEnabling(null);
    setHeld(false);
    setSwitchedOff(false);
  }
  const pending = typeof enabling === "object" ? enabling : null;
  const on = (value !== null && !switchedOff) || enabling !== null;
  const row = useRef<HTMLDivElement>(null);

  const commit = (next: number) => {
    const days = Math.min(3650, Math.max(minimum, Math.round(next)));
    setDraft(days);
    setHeld(false);
    if (days === pending?.days) return;
    if (value !== null) {
      onChange(days, () => {});
      return;
    }
    const submission = { days };
    setEnabling(submission);
    onChange(days, () => setEnabling((current) => (current === submission ? null : current)));
  };

  const switchOff = () => {
    setDraft(value);
    setHeld(false);
    setEnabling(null);
    if (value === null && pending === null) return;
    setSwitchedOff(true);
    onChange(null, () => setSwitchedOff(false));
  };

  return (
    <div
      ref={row}
      className="flex items-center gap-3"
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        if (held && draft !== null) commit(draft);
        else setEnabling((current) => (typeof current === "string" ? null : current));
      }}
    >
      {on ? (
        <NumberField
          value={draft}
          min={minimum}
          max={3650}
          step={1}
          size="sm"
          className="w-auto"
          onValueChange={(next) => {
            setDraft(next);
            setEnabling((current) => (current === "draft" ? "edited" : current));
          }}
          onValueCommitted={(next, { reason, event }) => {
            if (next === null) setDraft(value);
            else if (
              reason === "input-blur"
                ? event instanceof FocusEvent &&
                  event.relatedTarget instanceof Node &&
                  row.current?.contains(event.relatedTarget)
                : value === null
            ) {
              setDraft(next);
              setHeld(true);
            } else commit(next);
          }}
        >
          <NumberFieldGroup>
            <NumberFieldDecrement aria-label={t("storage.decrease", { label })} />
            <NumberFieldInput
              aria-label={t("storage.labelInDays", { label })}
              autoFocus={value === null}
              size={5}
              className="w-auto grow-0 text-right"
              // Any typed or pasted edit replaces a held age: NumberField commits it on blur itself,
              // and text it cannot parse yet must not leave the held age to be saved.
              onChange={() => setHeld(false)}
              onPaste={() => setHeld(false)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                if (event.key === "Enter") {
                  // Blurring lets NumberField parse the visible text and commit it once. It
                  // skips an unedited value, so an untouched draft is committed here.
                  const input = event.currentTarget;
                  const shown =
                    draft !== null && input.value === new Intl.NumberFormat().format(draft);
                  if (enabling === "draft" && shown) commit(draft);
                  input.blur();
                } else if (event.key === "Escape" && (held || typeof enabling === "string")) {
                  // An unhandled Escape closes the settings page.
                  event.preventDefault();
                  event.stopPropagation();
                  setDraft(pending?.days ?? value);
                  setHeld(false);
                  setEnabling((current) => (typeof current === "string" ? null : current));
                }
              }}
            />
            <span aria-hidden="true" className="self-center pr-2 text-xs">
              {t("storage.days")}
            </span>
            <NumberFieldIncrement aria-label={t("storage.increase", { label })} />
          </NumberFieldGroup>
        </NumberField>
      ) : (
        <span className="text-xs text-muted-foreground">{t("storage.off")}</span>
      )}
      <Switch
        aria-label={label}
        checked={on}
        // Keeps focus in the age field, so switching off never commits an edited age first.
        onMouseDown={(event) => event.preventDefault()}
        onCheckedChange={(enabled) => {
          if (enabled) {
            setDraft(8);
            setEnabling("draft");
          } else switchOff();
        }}
      />
    </div>
  );
}

const KEEP_WHEN_LABELS = {
  "any-local-files": "storage.keepAnyLocalFiles",
  "uncommitted-changes": "storage.keepUncommittedChanges",
  "tracked-changes": "storage.keepEditedTrackedFiles",
} as const;

function lastRunSummary(
  entries: readonly { readonly label: string; readonly counts: string }[],
  machineCount: number,
) {
  const first = entries[0];
  if (!first) return "";
  if (machineCount <= 1) return first.counts;
  if (entries.length === machineCount && entries.every((entry) => entry.counts === first.counts)) {
    return translateDynamic("storage.countsOnEveryMachine", { counts: first.counts });
  }
  return entries.map((entry) => `${entry.label}: ${entry.counts}`).join(" · ");
}

function CleanupResults({
  report,
  environmentLabel,
}: {
  report: StorageCleanupReport;
  environmentLabel: string;
}) {
  const { t } = useTranslation("settings");
  return (
    <>
      {report.entries.map((entry, index) => {
        const name =
          entry.kind === "worktree"
            ? ((entry.threadId === null
                ? entry.path
                : entry.path?.split(/[\\/]/).findLast(Boolean)) ?? t("storage.worktrees"))
            : entry.kind === "logs"
              ? t("storage.rotatedLogs")
              : t("storage.browserArtifacts");
        return (
          <SettingsRow
            key={`${entry.path ?? entry.kind}:${entry.threadId ?? index}`}
            title={<span className="wrap-anywhere select-text">{name}</span>}
            description={
              <span className="block space-y-2 wrap-anywhere select-text">
                <span className={`block ${entry.outcome === "failed" ? "text-destructive" : ""}`}>
                  {entry.reason}
                </span>
                <span className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 border-l border-border/60 pl-3">
                  <span>{t("storage.machine")}</span>
                  <span className="text-foreground/80">{environmentLabel}</span>
                  {entry.projectPath && (
                    <>
                      <span>{t("storage.project")}</span>
                      <code className="text-foreground/80">{entry.projectPath}</code>
                    </>
                  )}
                  {entry.path && (
                    <>
                      <span>{t("storage.folder")}</span>
                      <code className="text-foreground/80">{entry.path}</code>
                    </>
                  )}
                  {entry.threadTitle && (
                    <>
                      <span>{t("storage.thread")}</span>
                      <span>{entry.threadTitle}</span>
                    </>
                  )}
                </span>
              </span>
            }
            control={
              (entry.outcome === "removed" ||
                (entry.outcome === "kept" && entry.bytes !== null)) && (
                <span className="text-xs text-muted-foreground">
                  {[
                    entry.kind !== "worktree" && entry.files !== null
                      ? t("storage.fileCount", {
                          count: entry.files,
                          formatted: entry.files.toLocaleString(),
                        })
                      : null,
                    entry.bytes !== null ? formatBytes(entry.bytes) : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              )
            }
          />
        );
      })}
      {report.omittedCount > 0 && (
        <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
          {t("storage.moreResults", {
            environment: environmentLabel,
            count: report.omittedCount,
            formatted: report.omittedCount.toLocaleString(),
          })}
        </p>
      )}
      {report.entries.length === 0 && report.omittedCount === 0 && (
        <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
          {t("storage.nothingNeededCleanup", { environment: environmentLabel })}
        </p>
      )}
    </>
  );
}

const storageCleanupReportsAtom = environmentAtomList(
  "web-storage-cleanup-reports",
  (environmentId) => serverEnvironment.storageCleanupReport({ environmentId, input: {} }),
);
const storageCleanupPermissionsAtom = environmentAtomList(
  "web-storage-cleanup-permissions",
  serverEnvironment.runStorageCleanup.permissionAtom,
);

function CleanupSection() {
  const { t } = useTranslation("settings");
  const nowMinute = useNowMinute();
  const nowMs = Date.parse(`${nowMinute}:00.000Z`);
  const { connectedEnvironments } = useSettingsScope();
  const [pending, setPending] = useState(false);
  const run = useAtomCommand(serverEnvironment.runStorageCleanup);
  const supported = connectedEnvironments.filter(
    (environment) => environment.serverConfig?.environment.capabilities.storageCleanupRun === true,
  );
  const supportedIds = supported.map(({ environmentId }) => environmentId);
  const reports = useAtomValue(storageCleanupReportsAtom(environmentIdsKey(supportedIds)));
  const permissions = useAtomValue(storageCleanupPermissionsAtom(environmentIdsKey(supportedIds)));
  const state = supportedIds.map((environmentId, index) => {
    const query = reports[index]!;
    return {
      environmentId,
      allowed: permissions[index]!,
      report: query._tag === "Success" ? query.value : null,
      loading: query.waiting,
      failed: query._tag === "Failure",
    };
  });
  const hasRules = supported.some((environment) => {
    const settings = environment.serverConfig?.settings;
    if (!settings) return false;
    const enabled = (rules: WorktreeCleanupRules) =>
      rules.worktreeAfterDays !== null ||
      rules.worktreeSettledAfterDays !== null ||
      rules.worktreeOnMerge ||
      rules.worktreeOnDelete ||
      rules.worktreeUnchanged;
    return (
      settings.storageCleanup.browserArtifactsAfterDays !== null ||
      settings.storageCleanup.logsAfterDays !== null ||
      enabled(resolveWorktreeCleanup(settings, null)) ||
      Object.values(settings.projectSettingsOverrides).some(
        (override) =>
          override.worktreeCleanup?.mode === "custom" && enabled(override.worktreeCleanup.rules),
      )
    );
  });
  if (supported.length === 0) return null;
  const summaries = supported.map((environment) => {
    const query = state.find((entry) => entry.environmentId === environment.environmentId);
    const report = query?.report ?? null;
    return {
      environment,
      report,
      label: settingsScopeEnvironmentLabel(environment, connectedEnvironments),
      counts: report
        ? t("storage.runCounts", {
            removed: report.counts.removed,
            kept: report.counts.kept,
            failedTail:
              report.counts.failed > 0
                ? t("storage.runCountsFailedTail", { count: report.counts.failed })
                : "",
          })
        : "",
      description: report
        ? t("storage.lastRunSummary", {
            relative: formatRelativeTimeLabel(report.finishedAt, nowMs),
            bytes: formatBytes(report.bytesFreed),
            failedTail:
              report.counts.failed > 0
                ? ` ${t("storage.failedToRemoveTail", { count: report.counts.failed })}`
                : "",
          })
        : query?.failed
          ? t("storage.couldNotLoadLastRun")
          : query?.loading
            ? t("storage.loadingLastRun")
            : t("storage.cleanupNotRunYet"),
    };
  });
  const deleteNow = async () => {
    if (pending) return;
    setPending(true);
    await Promise.all(
      supported
        .filter((environment) =>
          state.some((entry) => entry.environmentId === environment.environmentId && entry.allowed),
        )
        .map(async (environment) => {
          const result = await run({ environmentId: environment.environmentId, input: {} });
          if (result._tag === "Success") {
            const failures = result.value.entries.filter((entry) => entry.outcome === "failed");
            if (failures.length > 0)
              toastManager.add({
                type: "error",
                title: t("storage.cleanupFailedOn", { environment: environment.label }),
                description: failures[0]!.reason,
              });
          } else if (!isAtomCommandInterrupted(result)) {
            toastManager.add({
              type: "error",
              title: t("storage.couldNotRunCleanupOn", { environment: environment.label }),
              description: String(squashAtomCommandFailure(result)),
            });
          }
        }),
    ).finally(() => setPending(false));
  };
  return (
    <SettingsSection id="storage-cleanup" title={t("storage.cleanup")} variant="plain">
      <SettingsGroup>
        <SettingsRow
          {...searchableSetting("storage-delete-now")}
          description={
            <span>
              {!hasRules
                ? t("storage.turnOnRuleFirst")
                : summaries.map(({ environment, label, description }) => (
                    <span key={environment.environmentId} className="block">
                      {supported.length > 1 ? `${label}: ` : ""}
                      {description}
                    </span>
                  ))}
            </span>
          }
          control={
            <Button
              variant="outline"
              size="sm"
              disabled={pending || !hasRules || !state.some((entry) => entry.allowed)}
              onClick={() => void deleteNow()}
            >
              {pending ? t("storage.deleting") : t("storage.deleteNow")}
            </Button>
          }
        />
      </SettingsGroup>
      {summaries.some(({ report }) => report !== null) && (
        <FoldedSettingsSection
          id="storage-cleanup-last-run"
          title={t("storage.lastRun")}
          headerPlacement="inside"
          summary={lastRunSummary(
            summaries.filter(({ report }) => report !== null),
            connectedEnvironments.length,
          )}
        >
          {summaries.map(
            ({ environment, label, report }) =>
              report && (
                <CleanupResults
                  key={environment.environmentId}
                  report={report}
                  environmentLabel={label}
                />
              ),
          )}
        </FoldedSettingsSection>
      )}
    </SettingsSection>
  );
}

function supportsStorageCleanup(
  environments: ReadonlyArray<{
    readonly serverConfig: {
      readonly environment: { readonly capabilities: { readonly storageCleanup?: boolean } };
    } | null;
  }>,
) {
  return environments.every(
    (environment) => environment.serverConfig?.environment.capabilities.storageCleanup === true,
  );
}

/** Narrows a mixed selection to the machines that support cleanup. */
function StorageCleanupScopeNotice() {
  const { connectedEnvironments } = useSettingsScope();
  const { t } = useTranslation("settings");
  return (
    <SettingsScopeNotice
      inline
      target="environment"
      eligibleEnvironmentIds={connectedEnvironments
        .filter(
          (environment) =>
            environment.serverConfig?.environment.capabilities.storageCleanup === true,
        )
        .map((environment) => environment.environmentId)}
    >
      {t("storage.cleanupScopeNotice")}
    </SettingsScopeNotice>
  );
}

export function WorktreeCleanupSection() {
  const { t } = useTranslation("settings");
  const { scope, environments, connectedEnvironments, targets, target } = useSettingsScope();
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
      ? t("storage.mixedAcrossMachines")
      : undefined;
  // A policy locks these through worktreeCleanup, which also reaches each project's own rules.
  const lockablePath = (key: keyof WorktreeCleanupRules) =>
    isProjectScope ? ["worktreeCleanup"] : ["worktreeCleanup", `storageCleanup.${key}`];
  const update = (patch: Partial<StorageCleanupSettings>, options?: SaveOptions) =>
    updateSettings({ storageCleanup: patch }, options);
  const updateWorktree = (patch: Partial<WorktreeCleanupRules>, options?: SaveOptions) =>
    isProjectScope
      ? updateSettings({ worktreeCleanup: { mode: "custom", rules: patch } }, options)
      : update(patch, options);

  if (
    isProjectScope &&
    connectedEnvironments.some(
      (environment) =>
        environment.serverConfig?.environment.capabilities.projectWorktreeCleanup !== true,
    )
  ) {
    return (
      <SettingsSection id="storage-worktrees" title={t("storage.cleanup")} variant="plain">
        <SettingsScopeNotice inline target="all">
          {t("storage.projectCleanupScopeNotice")}
        </SettingsScopeNotice>
      </SettingsSection>
    );
  }
  if (!supportsStorageCleanup(connectedEnvironments)) {
    return (
      <SettingsSection id="storage-worktrees" title={t("storage.cleanup")} variant="plain">
        <StorageCleanupScopeNotice />
      </SettingsSection>
    );
  }

  return (
    <SettingsSection id="storage-worktrees" title={t("storage.cleanup")}>
      <>
        {isProjectScope && (
          <SettingsRow
            title={t("storage.automaticWorktreeCleanup")}
            description={
              mode === "off"
                ? t("storage.modeOffDescription")
                : mode === "custom"
                  ? t("storage.modeCustomDescription")
                  : t("storage.modeInheritDescription")
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
                <SelectTrigger size="sm" aria-label={t("storage.automaticWorktreeCleanup")}>
                  <SelectValue>
                    {mixedModes
                      ? t("storage.mixed")
                      : mode === "inherit"
                        ? t("storage.inherit")
                        : mode === "off"
                          ? t("storage.off")
                          : t("storage.custom")}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="inherit">{t("storage.inherit")}</SelectItem>
                  <SelectItem value="off">{t("storage.off")}</SelectItem>
                  <SelectItem value="custom">{t("storage.custom")}</SelectItem>
                </SelectPopup>
              </Select>
            }
          />
        )}
        {(!isProjectScope || (!mixedModes && mode === "custom")) && (
          <>
            <SettingsRow
              title={t("storage.deleteDeletedThreads")}
              status={ruleStatus("worktreeOnDelete")}
              managedPaths={lockablePath("worktreeOnDelete")}
              description={t("storage.deleteDeletedThreadsDescription")}
              serverScoped={!isProjectScope}
              control={
                <Switch
                  aria-label={t("storage.deleteDeletedThreads")}
                  checked={settings.worktreeOnDelete}
                  onCheckedChange={(worktreeOnDelete) => updateWorktree({ worktreeOnDelete })}
                />
              }
            />
            <SettingsRow
              title={t("storage.deleteMerged")}
              status={ruleStatus("worktreeOnMerge")}
              managedPaths={lockablePath("worktreeOnMerge")}
              description={t("storage.deleteMergedDescription")}
              serverScoped={!isProjectScope}
              control={
                <Switch
                  aria-label={t("storage.deleteMerged")}
                  checked={settings.worktreeOnMerge}
                  onCheckedChange={(worktreeOnMerge) => updateWorktree({ worktreeOnMerge })}
                />
              }
            />
            <SettingsRow
              title={t("storage.deleteInactive")}
              status={ruleStatus("worktreeAfterDays")}
              managedPaths={lockablePath("worktreeAfterDays")}
              description={t("storage.deleteInactiveDescription")}
              serverScoped={!isProjectScope}
              control={
                <RetentionControl
                  label={t("storage.deleteInactive")}
                  value={settings.worktreeAfterDays}
                  onChange={(worktreeAfterDays, onFailed) =>
                    updateWorktree({ worktreeAfterDays }, { onFailed })
                  }
                />
              }
            />
            <AdvancedSettings
              // The keep-when search result lands on this section, not its row.
              targetIds={["storage-worktrees", searchableSetting("storage-worktree-keep-when").id]}
            >
              {connectedEnvironments.length > 0 &&
                connectedEnvironments.every(
                  (environment) =>
                    environment.serverConfig?.environment.capabilities.settledWorktreeCleanup ===
                    true,
                ) && (
                  <SettingsRow
                    title={t("storage.deleteSettled")}
                    managedPaths={lockablePath("worktreeSettledAfterDays")}
                    status={[
                      ruleStatus("worktreeSettledAfterDays"),
                      environments.length > connectedEnvironments.length
                        ? t("storage.offlineMachinesNote")
                        : undefined,
                    ]
                      .filter(Boolean)
                      .join(". ")}
                    description={t("storage.deleteSettledDescription")}
                    serverScoped={!isProjectScope}
                    control={
                      <RetentionControl
                        label={t("storage.deleteSettled")}
                        value={settings.worktreeSettledAfterDays}
                        minimum={0}
                        onChange={(worktreeSettledAfterDays, onFailed) =>
                          updateWorktree({ worktreeSettledAfterDays }, { onFailed })
                        }
                      />
                    }
                  />
                )}
              <SettingsRow
                title={t("storage.deleteUnchanged")}
                status={ruleStatus("worktreeUnchanged")}
                managedPaths={lockablePath("worktreeUnchanged")}
                description={t("storage.deleteUnchangedDescription")}
                serverScoped={!isProjectScope}
                control={
                  <Switch
                    aria-label={t("storage.deleteUnchanged")}
                    checked={settings.worktreeUnchanged}
                    onCheckedChange={(worktreeUnchanged) => updateWorktree({ worktreeUnchanged })}
                  />
                }
              />
              {connectedEnvironments.every(
                (environment) =>
                  environment.serverConfig?.environment.capabilities.storageCleanupRun === true,
              ) && (
                <SettingsRow
                  {...searchableSetting("storage-worktree-keep-when")}
                  status={ruleStatus("worktreeKeepWhen")}
                  managedPaths={lockablePath("worktreeKeepWhen")}
                  description={
                    settings.worktreeKeepWhen === "any-local-files"
                      ? t("storage.keepWhenAnyLocalFilesDescription")
                      : settings.worktreeKeepWhen === "tracked-changes"
                        ? t("storage.keepWhenTrackedChangesDescription")
                        : t("storage.keepWhenUncommittedDescription")
                  }
                  serverScoped={!isProjectScope}
                  control={
                    <Select
                      value={ruleStatus("worktreeKeepWhen") ? null : settings.worktreeKeepWhen}
                      onValueChange={(next) => {
                        if (
                          next === "any-local-files" ||
                          next === "uncommitted-changes" ||
                          next === "tracked-changes"
                        )
                          updateWorktree({ worktreeKeepWhen: next });
                      }}
                    >
                      <SelectTrigger size="sm" aria-label={t("storage.keepWithLocalChanges")}>
                        <SelectValue>
                          {ruleStatus("worktreeKeepWhen")
                            ? t("storage.mixed")
                            : t(KEEP_WHEN_LABELS[settings.worktreeKeepWhen])}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectPopup align="end" alignItemWithTrigger={false}>
                        <SelectItem value="any-local-files">
                          {t(KEEP_WHEN_LABELS["any-local-files"])}
                        </SelectItem>
                        <SelectItem value="uncommitted-changes">
                          {t(KEEP_WHEN_LABELS["uncommitted-changes"])}
                        </SelectItem>
                        <SelectItem value="tracked-changes">
                          {t(KEEP_WHEN_LABELS["tracked-changes"])}
                        </SelectItem>
                      </SelectPopup>
                    </Select>
                  }
                />
              )}
            </AdvancedSettings>
          </>
        )}
      </>
    </SettingsSection>
  );
}

/** Retention for logs and captures, and the manual cleanup run, which covers worktrees too. */
export function StorageCleanupSections() {
  const { t } = useTranslation("settings");
  const { scope, connectedEnvironments, targets } = useSettingsScope();
  const scopedSettings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const settings = scopedSettings.storageCleanup;
  const targetIdsKey = environmentIdsKey(targets.map((target) => target.environmentId).sort());
  const artifactsMixed =
    targets.length > 1 &&
    targets.some(
      (target) =>
        target.settings.storageCleanup.browserArtifactsAfterDays !==
        settings.browserArtifactsAfterDays,
    );
  const logsMixed =
    targets.length > 1 &&
    targets.some(
      (target) => target.settings.storageCleanup.logsAfterDays !== settings.logsAfterDays,
    );
  const settledArtifactsStatus = useDebouncedValue(`${targetIdsKey}:${artifactsMixed}`, 300);
  const settledLogsStatus = useDebouncedValue(`${targetIdsKey}:${logsMixed}`, 300);
  const artifactsStatus =
    targets.length > 1 && settledArtifactsStatus === `${targetIdsKey}:true`
      ? t("storage.mixedAcrossMachines")
      : undefined;
  const logsStatus =
    targets.length > 1 && settledLogsStatus === `${targetIdsKey}:true`
      ? t("storage.mixedAcrossMachines")
      : undefined;
  if (scope.kind === "project" || scope.kind === "checkout") return null;
  const update = (patch: Partial<StorageCleanupSettings>, options: SaveOptions) =>
    updateSettings({ storageCleanup: patch }, options);
  const databaseStorageNotice = (
    <DatabaseStorageNotice
      environments={connectedEnvironments.filter(
        (environment) =>
          environment.serverConfig?.environment.capabilities.databaseStorage === true,
      )}
    />
  );
  if (!supportsStorageCleanup(connectedEnvironments)) {
    return (
      <>
        {databaseStorageNotice}
        <SettingsSection
          id="storage-artifacts"
          title={t("storage.artifactsAndLogs")}
          variant="plain"
        >
          <StorageCleanupScopeNotice />
        </SettingsSection>
      </>
    );
  }

  return (
    <>
      {databaseStorageNotice}
      <SettingsSection id="storage-artifacts" title={t("storage.artifactsAndLogs")}>
        <AnimatedHeight>
          <SettingsRow
            title={t("storage.deleteOldBrowserArtifacts")}
            status={artifactsStatus}
            managedPaths={["storageCleanup.browserArtifactsAfterDays"]}
            description={t("storage.deleteOldBrowserArtifactsDescription")}
            serverScoped
            control={
              <RetentionControl
                label={t("storage.deleteOldBrowserArtifacts")}
                value={settings.browserArtifactsAfterDays}
                onChange={(browserArtifactsAfterDays, onFailed) =>
                  update({ browserArtifactsAfterDays }, { onFailed })
                }
              />
            }
          />
        </AnimatedHeight>
        <AnimatedHeight>
          <SettingsRow
            title={t("storage.deleteOldRotatedLogs")}
            status={logsStatus}
            managedPaths={["storageCleanup.logsAfterDays"]}
            description={t("storage.deleteOldRotatedLogsDescription")}
            serverScoped
            control={
              <RetentionControl
                label={t("storage.deleteOldRotatedLogs")}
                value={settings.logsAfterDays}
                onChange={(logsAfterDays, onFailed) => update({ logsAfterDays }, { onFailed })}
              />
            }
          />
        </AnimatedHeight>
      </SettingsSection>
      <CleanupSection />
    </>
  );
}
