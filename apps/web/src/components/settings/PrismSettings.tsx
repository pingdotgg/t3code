import {
  PRISM_ROLES,
  PrismLane,
  type PrismModelPreference,
  type PrismRole,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { useEnvironments } from "../../state/environments";
import { prismSaveStore } from "./PrismSettings.state";
import { ArrowDownIcon, ArrowUpIcon, TrashIcon } from "lucide-react";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
} from "../../providerInstances";
import { useThreadShells } from "../../state/entities";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useRightPanelStore } from "../../rightPanelStore";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { useScopedSettings } from "./useScopedSettings";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import { persistScopedSettingsPatch, planScopedSettingsClear } from "./scopedSettings";
import {
  movePrismPreference,
  planPrismModelsPatch,
  prismModelChoices,
  prismModelKey,
  type PrismWriteExpectation,
} from "./PrismSettings.logic";

type ModelChoice = ReturnType<typeof prismModelChoices>[number];

type DraftPreference = PrismModelPreference & { entryId: number };
const editablePreference = (model: PrismModelPreference, entryId: number): DraftPreference => ({
  ...model,
  entryId,
});
const savedPreferences = (models: readonly DraftPreference[]) =>
  models.map(({ entryId: _entryId, ...model }) => model);

function LanePreferences({
  role,
  lane,
  saved,
  choices,
  mixed,
  disabled,
  save,
}: {
  role: PrismRole;
  lane: PrismLane;
  saved: readonly PrismModelPreference[];
  choices: readonly ModelChoice[];
  mixed: boolean;
  disabled: boolean;
  save: (models: readonly PrismModelPreference[]) => Promise<void>;
}) {
  const [draft, setDraft] = useState<readonly DraftPreference[]>(() =>
    saved.map(editablePreference),
  );
  const nextEntryId = useRef(saved.length);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const dirty = JSON.stringify(savedPreferences(draft)) !== JSON.stringify(saved);
  const available = choices;
  const title = `${role.charAt(0).toUpperCase() + role.slice(1)} ${lane}`;
  const edit = (next: readonly DraftPreference[]) => {
    setDraft(next);
    setStatus(null);
    setError(null);
  };
  return (
    <div id={`prism-${role}-${lane}`} className="min-w-0 space-y-3 p-3">
      <h3 className="text-sm font-medium capitalize">{lane}</h3>
      <div className="space-y-3">
        {mixed && (
          <p className="text-sm text-muted-foreground">
            Preferences differ across this scope. Saving replaces this lane's model list on the
            selected targets.
          </p>
        )}
        {draft.length === 0 && (
          <p className="text-sm text-muted-foreground">No preferred models configured.</p>
        )}
        <ol className="space-y-2">
          {draft.map((entry, index) => {
            const choice = choices.find(
              (candidate) => prismModelKey(candidate.preference) === prismModelKey(entry),
            );
            const efforts = choice?.efforts ?? [];
            const unknownEffort =
              entry.effort && !efforts.some((effort) => effort.id === entry.effort);
            return (
              <li
                key={entry.entryId}
                className="flex flex-wrap items-center gap-2 rounded-lg border p-3"
              >
                <span className="text-xs text-muted-foreground">
                  {index === 0 ? "Primary" : `Fallback ${index}`}
                </span>
                <span className="min-w-0 flex-1 break-words text-sm">
                  {choice?.label ?? `${entry.instanceId} / ${entry.model}`}
                  {!choice && (
                    <span className="block text-xs text-muted-foreground">
                      Unavailable on one or more selected targets.
                    </span>
                  )}
                </span>
                <Select
                  value={entry.effort ?? ""}
                  disabled={disabled || pending || !choice}
                  onValueChange={(value) => {
                    if (value === null) return;
                    edit(
                      draft.map((model, position) =>
                        position === index
                          ? {
                              entryId: model.entryId,
                              instanceId: model.instanceId,
                              model: model.model,
                              ...(value ? { effort: value } : {}),
                            }
                          : model,
                      ),
                    );
                  }}
                >
                  <SelectTrigger size="sm" aria-label={`${title} preference ${index + 1} effort`}>
                    <SelectValue>{entry.effort ?? "Default effort"}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="">Default effort</SelectItem>
                    {unknownEffort && (
                      <SelectItem value={entry.effort!} disabled>
                        {entry.effort} (unavailable)
                      </SelectItem>
                    )}
                    {efforts.map((effort) => (
                      <SelectItem key={effort.id} value={effort.id}>
                        {effort.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Move ${title} preference ${index + 1} up`}
                  disabled={disabled || pending || index === 0}
                  onClick={() => edit(movePrismPreference(draft, index, -1))}
                >
                  <ArrowUpIcon />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Move ${title} preference ${index + 1} down`}
                  disabled={disabled || pending || index === draft.length - 1}
                  onClick={() => edit(movePrismPreference(draft, index, 1))}
                >
                  <ArrowDownIcon />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Remove ${title} preference ${index + 1}`}
                  disabled={disabled || pending}
                  onClick={() => edit(draft.filter((_, position) => position !== index))}
                >
                  <TrashIcon />
                </Button>
              </li>
            );
          })}
        </ol>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={null}
            disabled={disabled || pending || available.length === 0}
            onValueChange={(value) => {
              const choice = available.find(
                (candidate) => prismModelKey(candidate.preference) === value,
              );
              if (choice)
                edit([...draft, editablePreference(choice.preference, nextEntryId.current++)]);
            }}
          >
            <SelectTrigger size="sm" aria-label={`Add ${title} model`}>
              <SelectValue placeholder="Add model" />
            </SelectTrigger>
            <SelectPopup>
              {available.map((choice) => (
                <SelectItem
                  key={prismModelKey(choice.preference)}
                  value={prismModelKey(choice.preference)}
                >
                  {choice.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Button
            size="sm"
            aria-label={`Save ${title} preferences`}
            disabled={disabled || pending || (!dirty && !mixed)}
            onClick={async () => {
              setPending(true);
              setError(null);
              try {
                await save(savedPreferences(draft));
                setStatus("Saved");
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : "Could not save preferences.");
              } finally {
                setPending(false);
              }
            }}
          >
            {pending ? "Saving…" : `Save ${lane}`}
          </Button>
          {dirty && (
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => edit(saved.map(editablePreference))}
            >
              Discard changes
            </Button>
          )}
        </div>
        {choices.length === 0 && (
          <p className="text-xs text-muted-foreground">
            Enable models in Providers for this scope to add preferences.
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {status && (
          <p role="status" className="text-xs text-muted-foreground">
            {status}
          </p>
        )}
      </div>
    </div>
  );
}

export function PrismSettings() {
  const { scope, target, targets, environment, environments, connectedEnvironments } =
    useSettingsScope();
  const settings = useScopedSettings();
  const { pendingWrite, saveError, setSaveError } = useStore(prismSaveStore);
  const { environments: allEnvironments } = useEnvironments();
  const persist = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  useEffect(() => {
    if (pendingWrite?.acknowledged) prismSaveStore.getState().observe(allEnvironments);
  }, [allEnvironments, pendingWrite]);
  async function savePlan(
    plan: ReturnType<typeof planPrismModelsPatch>,
    expectation: PrismWriteExpectation,
  ) {
    if (plan.unavailableReason) throw new Error(plan.unavailableReason);
    if (!prismSaveStore.getState().begin(plan, expectation)) {
      throw new Error("Wait for the current settings update to finish.");
    }
    let result;
    try {
      result = await persistScopedSettingsPatch(plan, persist, () => {});
    } catch (cause) {
      prismSaveStore
        .getState()
        .fail(cause instanceof Error ? cause.message : "Could not save preferences.");
      throw cause;
    }
    const failed = new Set(result.failedEnvironments.map((env) => env.environmentId));
    prismSaveStore.getState().acknowledge(failed);
    if (failed.size) {
      const message = `Could not save preferences on ${result.failedEnvironments.map((env) => env.label).join(", ")}.${result.savedEnvironmentCount ? " Other selected environments saved the change." : ""}`;
      // The representative update remounts its lane editor, so failures also live on the page.
      setSaveError(message);
      throw new Error(message);
    }
  }

  const providers = environment?.serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS;
  const entries = applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings);
  const options = getCustomModelOptionsByInstance(settings, providers);
  const disabledReason = useScopedModelDisabledReason(settings, entries);
  const choices = prismModelChoices(entries, options, disabledReason);
  const threads = useThreadShells();
  const thread = threads
    .filter((candidate) =>
      targets.some(
        (selected) =>
          selected.environmentId === candidate.environmentId &&
          (selected.projectId === null || selected.projectId === candidate.projectId),
      ),
    )
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const openPanel = useRightPanelStore((state) => state.open);
  return (
    <SettingsPageContainer>
      <SettingsSection id="prism-roles" title="Prism (Model Router)">
        {pendingWrite && (
          <p role="status" className="px-3 text-xs text-muted-foreground sm:px-4">
            {pendingWrite.acknowledged ? "Waiting for settings refresh…" : "Saving preferences…"}
          </p>
        )}
        {saveError && (
          <p role="alert" className="px-3 text-sm text-destructive sm:px-4">
            {saveError}
          </p>
        )}
        <p className="px-3 text-sm text-muted-foreground sm:px-4">
          Each role has easy, medium and hard lanes. The first model is primary; the rest are
          fallbacks. Only models enabled in Providers for the selected scope are eligible.
        </p>
        {!target && (
          <p role="status" className="px-3 text-sm text-muted-foreground sm:px-4">
            Connect an environment to edit Prism preferences.
          </p>
        )}
        {(scope.kind === "project" || scope.kind === "checkout") && (
          <div className="px-3 sm:px-4">
            <Button
              size="sm"
              variant="ghost"
              disabled={!target || pendingWrite !== null}
              onClick={() => {
                void savePlan(planScopedSettingsClear(scope, environments, ["prismRoles"]), {
                  kind: "inherit",
                }).catch((cause: unknown) =>
                  setSaveError(
                    cause instanceof Error ? cause.message : "Could not reset role settings.",
                  ),
                );
              }}
            >
              Use environment role settings
            </Button>
          </div>
        )}
      </SettingsSection>
      {PRISM_ROLES.map((role) => (
        <SettingsSection
          key={role}
          id={`prism-${role}`}
          title={role.charAt(0).toUpperCase() + role.slice(1)}
        >
          <div className="grid min-w-0 divide-y lg:grid-cols-3 lg:divide-x lg:divide-y-0">
            {PrismLane.literals.map((lane) => (
              <LanePreferences
                key={`${role}:${lane}:${JSON.stringify(settings.prismRoles[role].lanes[lane])}`}
                role={role}
                lane={lane}
                saved={settings.prismRoles[role].lanes[lane]}
                choices={choices}
                disabled={!target || pendingWrite !== null}
                mixed={targets.some(
                  (candidate) =>
                    JSON.stringify(candidate.settings.prismRoles[role].lanes[lane]) !==
                    JSON.stringify(settings.prismRoles[role].lanes[lane]),
                )}
                save={(models) =>
                  savePlan(planPrismModelsPatch(scope, environments, role, lane, models), {
                    kind: "lane",
                    role,
                    lane,
                    models,
                  })
                }
              />
            ))}
          </div>
        </SettingsSection>
      ))}
      <SettingsSection id="prism-capacity" title="Live capacity">
        <div className="space-y-4 px-3 sm:px-4">
          {connectedEnvironments.map((env) => (
            <div key={env.environmentId} className="space-y-3">
              <h3 className="text-sm font-medium">{env.label}</h3>
              {(env.serverConfig?.providers ?? []).map((provider) => (
                <div key={provider.instanceId} className="space-y-2 rounded-lg border p-3">
                  <p className="text-sm">
                    {provider.displayName ?? provider.instanceId}
                    {!provider.enabled ? " (disabled)" : ""}
                  </p>
                  {provider.usageLimits?.checkedAt && (
                    <p className="text-xs text-muted-foreground">
                      Checked {new Date(provider.usageLimits.checkedAt).toLocaleString()}
                    </p>
                  )}
                  {provider.usageLimits?.unavailable && (
                    <p className="text-xs text-muted-foreground">
                      {provider.usageLimits.unavailable.message ??
                        (provider.usageLimits.unavailable.reason === "probeFailed"
                          ? "Usage refresh failed; showing the last reading if available."
                          : "Usage reporting is unsupported.")}
                    </p>
                  )}
                  {!provider.usageLimits?.windows.length && (
                    <p className="text-xs text-muted-foreground">No usage windows reported.</p>
                  )}
                  {provider.usageLimits?.windows.map((window) => (
                    <div key={window.id} className="space-y-1">
                      <div className="flex flex-wrap justify-between gap-2 text-xs">
                        <span>
                          {window.label}: {window.usedPercent}% used
                        </span>
                        <span className="text-muted-foreground">
                          {window.resetsAt
                            ? `Resets ${new Date(window.resetsAt).toLocaleString()}`
                            : "Reset time not reported"}
                        </span>
                      </div>
                      <meter
                        className="h-2 w-full"
                        aria-label={`${provider.displayName ?? provider.instanceId} ${window.label} used`}
                        min={0}
                        max={100}
                        value={window.usedPercent}
                      />
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ))}
          {connectedEnvironments.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Connect an environment to see its capacity.
            </p>
          )}
        </div>
      </SettingsSection>
      <SettingsSection id="prism-jobs" title="Recent Prism jobs">
        <div className="space-y-2 px-3 text-sm text-muted-foreground sm:px-4">
          <p>
            Recent jobs are not included in this snapshot. Open a thread's Agents panel to see Prism
            spawns.
          </p>
          {thread ? (
            <Link
              className="text-primary underline"
              to="/$environmentId/$threadId"
              params={{ environmentId: thread.environmentId, threadId: thread.id }}
              onClick={() => openPanel(scopeThreadRef(thread.environmentId, thread.id), "agents")}
            >
              Open Agents panel
            </Link>
          ) : (
            <Link className="text-primary underline" to="/">
              Open a thread to view Agents
            </Link>
          )}
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
