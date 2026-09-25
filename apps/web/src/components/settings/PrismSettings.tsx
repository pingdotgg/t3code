import {
  PRISM_ROLE_LABELS,
  PRISM_SWITCHABLE_ROLES,
  PrismLane,
  type PrismModelPreference,
  type PrismRole,
  type PrismSwitchableRole,
} from "@t3tools/contracts";
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { useEnvironments } from "../../state/environments";
import { prismSaveStore } from "./PrismSettings.state";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronsUpIcon,
  GripVerticalIcon,
  HammerIcon,
  LockIcon,
  RotateCcwIcon,
  RouteIcon,
  SearchCheckIcon,
  TrashIcon,
} from "lucide-react";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
} from "../../providerInstances";
import { cn } from "../../lib/utils";
import { useThreadShells } from "../../state/entities";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useRightPanelStore } from "../../rightPanelStore";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsGroup } from "./SettingsGroup";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { useScopedSettings } from "./useScopedSettings";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import { persistScopedSettingsPatch, planScopedSettingsClear } from "./scopedSettings";
import {
  movePrismPreference,
  planPrismRolePatch,
  prismModelChoices,
  prismModelKey,
  type PrismRoleUpdate,
  type PrismWriteExpectation,
} from "./PrismSettings.logic";

type ModelChoice = ReturnType<typeof prismModelChoices>[number];

/** The planner is whoever submits the job; it is not configured here. */
const PAGE_ROLES = ["dispatcher", "worker", "reviewer", "correction", "recovery"] as const;
type PageRole = (typeof PAGE_ROLES)[number];

const ROLE_DETAILS: Record<
  PageRole,
  { icon: ReactNode; description: string; lockedReason?: string }
> = {
  dispatcher: {
    icon: <RouteIcon />,
    description: "Owns a job: runs workers, handles problems and delivers one PR.",
    lockedReason: "Needed until router #117 decides whether jobs keep a dispatcher.",
  },
  worker: {
    icon: <HammerIcon />,
    description: "Implements the task and commits as it works.",
    lockedReason: "Required.",
  },
  reviewer: {
    icon: <SearchCheckIcon />,
    description: "Reviews the finished change before the PR is ready.",
    lockedReason: "Independent review is required.",
  },
  correction: {
    icon: <RotateCcwIcon />,
    description: "Takes over a failed worker turn on another model.",
  },
  recovery: {
    icon: <ChevronsUpIcon />,
    description: "Moves stuck work to a stronger model before asking the planner.",
  },
};

const LANE_LABELS: Record<PrismLane, string> = { easy: "Easy", medium: "Medium", hard: "Hard" };

const isSwitchable = (role: PrismRole): role is PrismSwitchableRole =>
  (PRISM_SWITCHABLE_ROLES as readonly PrismRole[]).includes(role);

type DraftPreference = PrismModelPreference & { entryId: number };
const editablePreference = (model: PrismModelPreference, entryId: number): DraftPreference => ({
  ...model,
  entryId,
});
const savedPreferences = (models: readonly DraftPreference[]) =>
  models.map(({ entryId: _entryId, ...model }) => model);

function ModelRow({
  entry,
  index,
  count,
  title,
  choice,
  disabled,
  onChange,
  onMove,
  onRemove,
}: {
  entry: DraftPreference;
  index: number;
  count: number;
  title: string;
  choice: ModelChoice | undefined;
  disabled: boolean;
  onChange: (effort: string) => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: entry.entryId,
    disabled,
  });
  const efforts = choice?.efforts ?? [];
  const unknownEffort = entry.effort && !efforts.some((effort) => effort.id === entry.effort);
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-lg border bg-card p-2",
        isDragging && "relative z-10 shadow-md",
      )}
    >
      <Button
        size="icon-sm"
        variant="ghost-muted"
        className="cursor-grab touch-none"
        aria-label={`Drag ${title} preference ${index + 1}`}
        disabled={disabled}
        {...attributes}
        {...listeners}
      >
        <GripVerticalIcon />
      </Button>
      <span className="w-16 shrink-0 text-xs text-muted-foreground">
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
        disabled={disabled || !choice}
        onValueChange={(value) => {
          if (value !== null) onChange(value);
        }}
      >
        <SelectTrigger
          size="sm"
          className="w-fit"
          aria-label={`${title} preference ${index + 1} effort`}
        >
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
        disabled={disabled || index === 0}
        onClick={() => onMove(-1)}
      >
        <ArrowUpIcon />
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={`Move ${title} preference ${index + 1} down`}
        disabled={disabled || index === count - 1}
        onClick={() => onMove(1)}
      >
        <ArrowDownIcon />
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={`Remove ${title} preference ${index + 1}`}
        disabled={disabled}
        onClick={onRemove}
      >
        <TrashIcon />
      </Button>
    </li>
  );
}

/** One ordered list, saved on every change like the Providers page. */
function ModelList({
  title,
  saved,
  choices,
  mixed,
  disabled,
  save,
}: {
  title: string;
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
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const commit = (next: readonly DraftPreference[]) => {
    setDraft(next);
    // The page shows the failure; the list returns to what is saved.
    save(savedPreferences(next)).catch(() => setDraft(saved.map(editablePreference)));
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    const from = draft.findIndex((entry) => entry.entryId === active.id);
    const to = draft.findIndex((entry) => entry.entryId === over?.id);
    if (from >= 0 && to >= 0 && from !== to) commit(arrayMove([...draft], from, to));
  };
  return (
    <div className="space-y-3">
      {mixed && (
        <p className="text-sm text-muted-foreground">
          Preferences differ across this scope. A change replaces this list on the selected targets.
        </p>
      )}
      {draft.length === 0 && (
        <p className="text-sm text-muted-foreground">No preferred models configured.</p>
      )}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis]}
        onDragEnd={onDragEnd}
      >
        <SortableContext
          items={draft.map((entry) => entry.entryId)}
          strategy={verticalListSortingStrategy}
        >
          <ol className="space-y-2">
            {draft.map((entry, index) => (
              <ModelRow
                key={entry.entryId}
                entry={entry}
                index={index}
                count={draft.length}
                title={title}
                choice={choices.find(
                  (candidate) => prismModelKey(candidate.preference) === prismModelKey(entry),
                )}
                disabled={disabled}
                onChange={(effort) =>
                  commit(
                    draft.map((model, position) =>
                      position === index
                        ? {
                            entryId: model.entryId,
                            instanceId: model.instanceId,
                            model: model.model,
                            ...(effort ? { effort } : {}),
                          }
                        : model,
                    ),
                  )
                }
                onMove={(direction) => commit(movePrismPreference(draft, index, direction))}
                onRemove={() => commit(draft.filter((_, position) => position !== index))}
              />
            ))}
          </ol>
        </SortableContext>
      </DndContext>
      <Select
        value={null}
        disabled={disabled || choices.length === 0}
        onValueChange={(value) => {
          const choice = choices.find((candidate) => prismModelKey(candidate.preference) === value);
          if (choice)
            commit([...draft, editablePreference(choice.preference, nextEntryId.current++)]);
        }}
      >
        <SelectTrigger size="sm" className="w-fit" aria-label={`Add ${title} model`}>
          <SelectValue placeholder="Add model" />
        </SelectTrigger>
        <SelectPopup>
          {choices.map((choice) => (
            <SelectItem
              key={prismModelKey(choice.preference)}
              value={prismModelKey(choice.preference)}
            >
              {choice.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      {choices.length === 0 && (
        <p className="text-xs text-muted-foreground">
          Enable models in Providers for this scope to add preferences.
        </p>
      )}
    </div>
  );
}

function RoleRow({
  role,
  enabled,
  selected,
  disabled,
  onSelect,
  onEnabledChange,
}: {
  role: PageRole;
  enabled: boolean;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
  onEnabledChange: (enabled: boolean) => void;
}) {
  const { icon, description, lockedReason } = ROLE_DETAILS[role];
  const name = PRISM_ROLE_LABELS[role];
  return (
    <div
      data-slot="settings-row"
      className={cn(
        "group flex min-h-18 items-center gap-3 px-3 py-3 transition-colors sm:px-4",
        selected ? "bg-muted/45" : "hover:bg-muted/25",
      )}
    >
      <div
        className={cn(
          "pointer-events-none relative flex min-w-0 flex-1 items-start gap-3 rounded-md text-left transition-opacity",
          !enabled && !selected && "opacity-60 group-hover:opacity-100",
        )}
      >
        <button
          type="button"
          className="pointer-events-auto absolute inset-0 cursor-pointer rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onSelect}
          aria-label={`Select ${name}`}
          aria-pressed={selected}
        />
        <span className="mt-0.5 flex size-4 shrink-0 text-muted-foreground [&_svg]:size-4">
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">{name}</span>
          <span className="mt-0.5 line-clamp-2 text-xs leading-normal text-muted-foreground/80">
            {description}
          </span>
        </span>
      </div>
      <span className="flex h-5 shrink-0 items-center gap-1.5">
        {lockedReason ? <LockIcon aria-hidden className="size-3.5 text-muted-foreground" /> : null}
        {lockedReason ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span tabIndex={0} className="inline-flex">
                  <Switch checked disabled aria-label={`${name} is always on: ${lockedReason}`} />
                </span>
              }
            />
            <TooltipPopup side="top">{lockedReason}</TooltipPopup>
          </Tooltip>
        ) : (
          <Switch
            checked={enabled}
            disabled={disabled}
            onCheckedChange={(checked) => onEnabledChange(Boolean(checked))}
            aria-label={`Enable ${name}`}
          />
        )}
      </span>
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
    plan: ReturnType<typeof planPrismRolePatch>,
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
      // The representative update remounts its list editor, so failures also live on the page.
      setSaveError(message);
      throw new Error(message);
    }
  }
  const saveRole = (update: PrismRoleUpdate) =>
    savePlan(planPrismRolePatch(scope, environments, update), update).catch((cause: unknown) => {
      setSaveError(cause instanceof Error ? cause.message : "Could not save preferences.");
      throw cause;
    });
  const [selectedRole, setSelectedRole] = useState<PageRole>("dispatcher");
  const [workerLane, setWorkerLane] = useState<PrismLane>("medium");
  const roleEnabled = (role: PageRole) =>
    isSwitchable(role) ? settings.prismRoles[role].enabled : true;

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
    <SettingsPageContainer width="wide" className="@container/prism gap-8">
      <SettingsSection
        id="prism-roles"
        title="Prism (Model Router)"
        variant="plain"
        headerAction={
          scope.kind === "project" || scope.kind === "checkout" ? (
            <Button
              size="xs"
              variant="ghost-muted"
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
          ) : null
        }
      >
        <p className="px-3 text-sm text-muted-foreground sm:px-4">
          The first model in a list is primary; the rest are fallbacks. Only models enabled in
          Providers for the selected scope are eligible. Changes save automatically.
        </p>
        {!target && (
          <p role="status" className="px-3 text-sm text-muted-foreground sm:px-4">
            Connect an environment to edit Prism preferences.
          </p>
        )}
        {saveError && (
          <p role="alert" className="px-3 text-sm text-destructive sm:px-4">
            {saveError}
          </p>
        )}
        <SettingsGroup
          divided={false}
          className="overflow-hidden @min-[48rem]/prism:grid @min-[48rem]/prism:min-h-[28rem] @min-[48rem]/prism:grid-cols-[17rem_minmax(0,1fr)]"
        >
          <div className="divide-y divide-border/50 border-b border-border/60 bg-muted/10 @min-[48rem]/prism:border-r @min-[48rem]/prism:border-b-0">
            {PAGE_ROLES.map((role) => (
              <RoleRow
                key={role}
                role={role}
                enabled={roleEnabled(role)}
                selected={selectedRole === role}
                disabled={!target || pendingWrite !== null}
                onSelect={() => setSelectedRole(role)}
                onEnabledChange={(enabled) => {
                  if (isSwitchable(role))
                    void saveRole({ kind: "enabled", role, enabled }).catch(() => {});
                }}
              />
            ))}
          </div>
          <div id={`prism-${selectedRole}`} className="min-w-0 space-y-4 p-4">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex size-4 shrink-0 text-muted-foreground [&_svg]:size-4">
                {ROLE_DETAILS[selectedRole].icon}
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-medium">{PRISM_ROLE_LABELS[selectedRole]}</h3>
                <p className="text-xs text-muted-foreground">
                  {ROLE_DETAILS[selectedRole].description}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {ROLE_DETAILS[selectedRole].lockedReason
                    ? `Always on. ${ROLE_DETAILS[selectedRole].lockedReason}`
                    : roleEnabled(selectedRole)
                      ? "On. Switch it off to skip this step."
                      : "Off. Prism skips this step."}
                </p>
              </div>
              {pendingWrite && (
                <span role="status" className="shrink-0 text-xs text-muted-foreground">
                  Saving…
                </span>
              )}
            </div>
            {selectedRole === "worker" ? (
              <>
                <ToggleGroup
                  aria-label="Worker lanes"
                  variant="segmented"
                  value={[workerLane]}
                  onValueChange={(next) => {
                    const lane = PrismLane.literals.find((candidate) => candidate === next[0]);
                    if (lane) setWorkerLane(lane);
                  }}
                >
                  {PrismLane.literals.map((lane) => (
                    <Toggle key={lane} value={lane}>
                      {LANE_LABELS[lane]}
                    </Toggle>
                  ))}
                </ToggleGroup>
                <ModelList
                  key={`worker:${workerLane}:${JSON.stringify(settings.prismRoles.worker.lanes[workerLane])}`}
                  title={`Worker ${workerLane}`}
                  saved={settings.prismRoles.worker.lanes[workerLane]}
                  choices={choices}
                  disabled={!target || pendingWrite !== null}
                  mixed={targets.some(
                    (candidate) =>
                      JSON.stringify(candidate.settings.prismRoles.worker.lanes[workerLane]) !==
                      JSON.stringify(settings.prismRoles.worker.lanes[workerLane]),
                  )}
                  save={(models) =>
                    saveRole({ kind: "lane", role: "worker", lane: workerLane, models })
                  }
                />
              </>
            ) : (
              <ModelList
                key={`${selectedRole}:${JSON.stringify(settings.prismRoles[selectedRole].models)}`}
                title={PRISM_ROLE_LABELS[selectedRole]}
                saved={settings.prismRoles[selectedRole].models}
                choices={choices}
                disabled={!target || pendingWrite !== null}
                mixed={targets.some(
                  (candidate) =>
                    JSON.stringify(candidate.settings.prismRoles[selectedRole].models) !==
                    JSON.stringify(settings.prismRoles[selectedRole].models),
                )}
                save={(models) => saveRole({ kind: "models", role: selectedRole, models })}
              />
            )}
          </div>
        </SettingsGroup>
      </SettingsSection>
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
