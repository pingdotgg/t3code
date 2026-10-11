import {
  AuthProvidersManageScope,
  type EnvironmentId,
  mcpServerTransportSummary,
  type McpServerConfig,
  type McpServerProjectOverride,
  type McpServerTransport,
  type ProjectId,
  type ServerProvider,
  type ServerSettingsPatch,
  type SkillFolderInfo,
  type SkillInstallTarget,
  T3_MCP_SERVER_NAME,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import {
  isSkillDisabled,
  mcpServerEnabledPatch,
  projectOverridePatch,
  skillsDisabledPatch,
} from "@t3tools/shared/agentTools";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import {
  AlertTriangleIcon,
  ChevronRightIcon,
  MoreHorizontalIcon,
  PlusIcon,
  SearchIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useAfterDelay } from "../../hooks/useAfterDelay";
import { cn } from "../../lib/utils";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { RefreshIcon } from "../ui/refresh-icon";
import { Skeleton } from "../ui/skeleton";
import { Switch } from "../ui/switch";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AddSkillsDialog } from "./AddSkillsDialog";
import { McpServerDetail } from "./McpServerDetail";
import { McpServerDialog } from "./McpServerDialog";
import { SettingsGroup } from "./SettingsGroup";
import { SkillDetail } from "./SkillDetail";
import {
  type SkillEnvironment,
  useEnvironmentProviders,
  useEnvironmentSkillFolders,
} from "./SkillEnvironments";
import { SkillListSection, type SkillListRow, stopRowClick } from "./SkillList";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  collectSkillRows,
  type FleetSkillRow,
  filterSkillRows,
  groupSkillRows,
  listMcpServerRows,
  type McpServerRow,
  mergeEnvironmentSkillRows,
  SKILL_GROUP_HINTS,
  SKILL_GROUP_LABELS,
  skillAgents,
  skillConflict,
  type SkillGroupKind,
  type SkillRow,
  skillRowDetails,
  splitRowsBySource,
  type ToolsTab,
} from "./toolsSettings.logic";
import { useScopedSettings, useScopedSettingsWriteAllowed } from "./useScopedSettings";

const EMPTY_PROVIDERS: ReadonlyArray<ServerProvider> = [];
const EMPTY_FOLDERS: ReadonlyMap<string, SkillFolderInfo> = new Map();
/** A scan that finishes sooner than this shows no placeholder at all. */
const SKELETON_DELAY_MS = 150;

interface ToolsTarget {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly projectId: ProjectId | null;
  readonly cwd: string | null;
}

/**
 * The environments and project checkouts a Tools change writes to. Project
 * scope writes the project's override on each member's environment, so one
 * edit reaches the project everywhere it is checked out.
 */
function useToolsTargets(): ReadonlyArray<ToolsTarget> {
  const { scope, connectedEnvironments } = useSettingsScope();
  return useMemo(() => {
    const connected = new Map(
      connectedEnvironments.map((environment) => [environment.environmentId, environment]),
    );
    if (scope.kind === "project" || scope.kind === "checkout") {
      return scope.members.flatMap((member) => {
        const environment = connected.get(member.environmentId);
        return environment
          ? [
              {
                environmentId: member.environmentId,
                label: environment.label,
                projectId: member.id,
                cwd: member.workspaceRoot,
              },
            ]
          : [];
      });
    }
    return connectedEnvironments.map((environment) => ({
      environmentId: environment.environmentId,
      label: environment.label,
      projectId: null,
      cwd: null,
    }));
  }, [connectedEnvironments, scope]);
}

type ToolsSettingsSnapshot = NonNullable<
  ReturnType<typeof useSettingsScope>["connectedEnvironments"][number]["serverConfig"]
>["settings"];

/**
 * Write a Tools change to every target. `apply` receives the target's raw
 * environment settings and returns its patch: the environment's own key at
 * environment scope, or the project's override entry at project scope.
 *
 * Each patch replaces a whole list or project entry, so it is built on the
 * settings this page last wrote rather than the last ones the server pushed:
 * a second click before the first save comes back must not undo it.
 */
function usePersistToolsPatch() {
  const targets = useToolsTargets();
  const { connectedEnvironments } = useSettingsScope();
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "update tools",
  });
  const written = useRef(
    new Map<
      string,
      { readonly base: ToolsSettingsSnapshot; readonly next: ToolsSettingsSnapshot }
    >(),
  );
  return useCallback(
    (
      apply: (input: {
        readonly settings: ToolsSettingsSnapshot;
        readonly projectId: ProjectId | null;
      }) => ServerSettingsPatch | null,
    ) => {
      for (const target of targets) {
        const pushed = connectedEnvironments.find(
          (environment) => environment.environmentId === target.environmentId,
        )?.serverConfig?.settings;
        if (!pushed) continue;
        const pending = written.current.get(target.environmentId);
        // Once the server pushes newer settings, they are the base again.
        const settings = pending !== undefined && pending.base === pushed ? pending.next : pushed;
        const patch = apply({ settings, projectId: target.projectId });
        if (patch === null) continue;
        written.current.set(target.environmentId, {
          base: pushed,
          next: applyServerSettingsPatch(settings, patch),
        });
        void updateSettings({ environmentId: target.environmentId, input: { patch } });
      }
    },
    [connectedEnvironments, targets, updateSettings],
  );
}

/** Settings → Tools: the skills and MCP servers agents get, as two tabs. */
export function ToolsSettings({
  tab = "skills",
  skill,
  server,
  onTabChange,
  onOpenSkill,
  onOpenServer,
}: {
  readonly tab?: ToolsTab;
  /** The skill whose page is open in place of the list; the header names it. */
  readonly skill?: string;
  /** The MCP server whose page is open in place of the list; the header names it. */
  readonly server?: string;
  readonly onTabChange: (tab: ToolsTab) => void;
  readonly onOpenSkill: (name: string | null) => void;
  readonly onOpenServer: (name: string | null) => void;
}) {
  // Each tab puts these at the start of its own toolbar row.
  const tabs = (
    <ToggleGroup
      aria-label="Tools"
      variant="segmented"
      value={[tab]}
      onValueChange={(next) => {
        const value = next[0];
        if (value === "skills" || value === "mcp") onTabChange(value);
      }}
    >
      <Toggle value="skills">Skills</Toggle>
      <Toggle value="mcp">MCP servers</Toggle>
    </ToggleGroup>
  );
  return (
    <SettingsPageContainer>
      {tab === "mcp" ? (
        <McpServersPanel tabs={tabs} openName={server ?? null} onOpen={onOpenServer} />
      ) : (
        <SkillsPanel tabs={tabs} openName={skill ?? null} onOpen={onOpenSkill} />
      )}
    </SettingsPageContainer>
  );
}

// ── Skills ───────────────────────────────────────────────────────────

function SkillsPanel({
  tabs,
  openName,
  onOpen,
}: {
  tabs: ReactNode;
  openName: string | null;
  onOpen: (name: string | null) => void;
}) {
  const { scope, target, connectedEnvironments } = useSettingsScope();
  const environmentId = target?.environmentId ?? null;
  const targets = useToolsTargets();
  const cwd = targets.find((candidate) => candidate.environmentId === environmentId)?.cwd ?? null;
  // Every environment the scope covers, the representative one first: rows
  // show its copy of a skill when it has one.
  const environments = useMemo((): ReadonlyArray<SkillEnvironment> => {
    const ordered = [
      ...targets.filter((candidate) => candidate.environmentId === environmentId),
      ...targets.filter((candidate) => candidate.environmentId !== environmentId),
    ];
    return ordered.flatMap((candidate) => {
      const connected = connectedEnvironments.find(
        (environment) => environment.environmentId === candidate.environmentId,
      );
      return connected === undefined
        ? []
        : [
            {
              environmentId: candidate.environmentId,
              label: connected.label,
              serverConfig: connected.serverConfig,
              cwd: candidate.cwd,
            },
          ];
    });
  }, [connectedEnvironments, environmentId, targets]);
  const fleet = environments.length > 1;
  const environmentProviders = useEnvironmentProviders(environments);
  const providers =
    environmentProviders.find((entry) => entry.environmentId === environmentId)?.providers ??
    EMPTY_PROVIDERS;
  const disabledSkills = useScopedSettings((settings) => settings.disabledSkills);
  const canWrite = useScopedSettingsWriteAllowed();
  const persist = usePersistToolsPatch();
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const [query, setQuery] = useState("");
  const [onlyAttention, setOnlyAttention] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  // Installs go to the checkout shown, or to the environment's home folders.
  const installTarget: SkillInstallTarget | null =
    environmentId === null
      ? null
      : isProjectScope
        ? cwd === null
          ? null
          : { kind: "project", cwd }
        : { kind: "environment" };
  const canInstall = useAtomValue(serverEnvironment.installSkills.permissionAtom(environmentId));
  const installers = useEnvironmentsWithScope(environments, AuthProvidersManageScope);
  const exportSkill = useAtomCommand(serverEnvironment.exportSkill, { reportFailure: false });
  const importSkill = useAtomCommand(serverEnvironment.importSkill, { reportFailure: false });
  const [syncing, setSyncing] = useState<ReadonlySet<string>>(new Set());
  const updateSkill = useAtomCommand(serverEnvironment.updateSkill, { reportFailure: false });
  const removeSkill = useAtomCommand(serverEnvironment.removeSkill, { reportFailure: false });
  const [adding, setAdding] = useState(false);
  const [removingSkill, setRemovingSkill] = useState<{
    readonly name: string;
    /** Each environment's copy to remove. */
    readonly inputs: ReadonlyArray<{
      readonly environmentId: EnvironmentId;
      readonly name: string;
      readonly target: SkillInstallTarget;
    }>;
    /** The `skills` CLI installed the shown copy, so its lock entry goes too. */
    readonly installed: boolean;
  } | null>(null);
  const [skillActionError, setSkillActionError] = useState<string | null>(null);
  const inspected = useEnvironmentSkillFolders(environments);
  const foldersOf = (id: EnvironmentId) => inspected.folders.get(id) ?? EMPTY_FOLDERS;
  const scopeLabel = isProjectScope
    ? scope.kind === "project" || scope.kind === "checkout"
      ? scope.group.displayName
      : ""
    : scope.kind === "environment"
      ? scope.label
      : "this environment";

  // Rescans every environment in scope; a project's checkout is only scanned
  // when asked, as the composer does before showing its skill menu.
  const refresh = async (fresh: boolean) => {
    if (environments.length === 0) return;
    setRefreshing(true);
    try {
      await Promise.all(
        environments.flatMap((environment) =>
          (
            environmentProviders.find((entry) => entry.environmentId === environment.environmentId)
              ?.providers ?? EMPTY_PROVIDERS
          )
            .filter((provider) => provider.enabled)
            .map((provider) =>
              refreshProviders({
                environmentId: environment.environmentId,
                input: {
                  instanceId: provider.instanceId,
                  ...(environment.cwd === null ? {} : { cwd: environment.cwd }),
                  ...(fresh ? { fresh: true } : {}),
                },
              }),
            ),
        ),
      );
    } finally {
      setRefreshing(false);
      inspected.refresh();
    }
  };

  const afterSkillChange = () => {
    inspected.refresh();
  };

  /** A skill's level on one environment: where it lives there, to update or remove it. */
  type SkillAction = {
    readonly environmentId: EnvironmentId;
    readonly name: string;
    readonly target: SkillInstallTarget;
  };

  const runSkillAction = async (
    action: "update" | "remove",
    inputs: ReadonlyArray<SkillAction>,
  ) => {
    setSkillActionError(null);
    const failures = await Promise.all(
      inputs.map(async ({ environmentId: id, ...input }) => {
        const label = environmentLabel(id);
        if (action === "remove") {
          const result = await removeSkill({ environmentId: id, input });
          return result._tag === "Failure"
            ? `${label}: ${formatEnvironmentQueryError(result.cause)}`
            : null;
        }
        const result = await updateSkill({ environmentId: id, input });
        if (result._tag === "Failure")
          return `${label}: ${formatEnvironmentQueryError(result.cause)}`;
        // The CLI reports a skill it couldn't reinstall as a result, not an error.
        const failed = result.value.outcomes.find((outcome) => outcome.status !== "installed");
        return failed === undefined ? null : `${label}: ${failed.error ?? failed.status}`;
      }),
    );
    afterSkillChange();
    const messages = failures.filter((message) => message !== null);
    if (messages.length > 0) {
      setSkillActionError(
        `Couldn't ${action} ${inputs[0]?.name ?? "the skill"}. ${messages.join(" ")}`,
      );
    }
  };

  const scanKey = `${environments.map((environment) => `${environment.environmentId}:${environment.cwd ?? ""}`).join(",")}:${environmentProviders
    .flatMap((entry) => entry.providers.filter((provider) => provider.enabled))
    .map((provider) => provider.instanceId)
    .join(",")}`;
  const scannedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!environments.some((environment) => environment.cwd !== null)) return;
    if (scannedKeyRef.current === scanKey) return;
    scannedKeyRef.current = scanKey;
    void refresh(false);
  }, [environments, refresh, scanKey]);

  const environmentLabel = (id: EnvironmentId) =>
    environments.find((environment) => environment.environmentId === id)?.label ?? "Environment";

  // Each environment's rows, merged by name: a row shows the first copy found.
  const fleetRows = useMemo(
    () =>
      mergeEnvironmentSkillRows(
        environments.map((environment) => ({
          environmentId: environment.environmentId,
          rows: collectSkillRows(
            environmentProviders.find((entry) => entry.environmentId === environment.environmentId)
              ?.providers ?? EMPTY_PROVIDERS,
            environment.cwd,
          ),
        })),
      ),
    [environmentProviders, environments],
  );
  const fleetByName = useMemo(
    () => new Map(fleetRows.map((entry) => [entry.row.name, entry])),
    [fleetRows],
  );
  const rows = useMemo(() => fleetRows.map((entry) => entry.row), [fleetRows]);
  // Agents on the environment whose copy a row shows.
  const agentsByEnvironment = useMemo(
    () =>
      new Map(
        environmentProviders.map((entry) => [entry.environmentId, skillAgents(entry.providers)]),
      ),
    [environmentProviders],
  );
  const agents = useMemo(() => skillAgents(providers), [providers]);
  const fleetOf = (row: SkillRow): FleetSkillRow =>
    fleetByName.get(row.name) ?? {
      row,
      environmentId: environmentId ?? ("" as EnvironmentId),
      on: [],
    };
  const detailsByName = useMemo(
    () =>
      new Map(
        fleetRows.map((entry) => [
          entry.row.name,
          skillRowDetails(entry.row, inspected.folders.get(entry.environmentId) ?? EMPTY_FOLDERS),
        ]),
      ),
    [fleetRows, inspected.folders],
  );
  const detailsOf = (row: SkillRow) =>
    detailsByName.get(row.name) ?? skillRowDetails(row, foldersOf(fleetOf(row).environmentId));
  const attentionNames = useMemo(
    () =>
      new Set(
        rows
          .filter((row) => {
            const details = detailsByName.get(row.name);
            return details !== undefined && skillConflict(row, details) !== null;
          })
          .map((row) => row.name),
      ),
    [detailsByName, rows],
  );
  const visibleRows = useMemo(
    () =>
      filterSkillRows(rows, query).filter((row) => !onlyAttention || attentionNames.has(row.name)),
    [attentionNames, onlyAttention, query, rows],
  );
  const groups = useMemo(() => groupSkillRows(visibleRows), [visibleRows]);
  const totals = useMemo(() => {
    const counts = new Map<SkillGroupKind, number>();
    for (const row of rows) counts.set(row.group, (counts.get(row.group) ?? 0) + 1);
    return counts;
  }, [rows]);

  const setSkillsDisabled = (skillRows: ReadonlyArray<SkillRow>, disabled: boolean) =>
    persist(({ settings, projectId }) =>
      skillsDisabledPatch(
        settings,
        projectId,
        skillRows.map((row) => row.name),
        disabled,
      ),
    );
  const projectOverrides = (name: string) =>
    isProjectScope &&
    targets.some(
      (candidate) =>
        candidate.projectId !== null &&
        Object.hasOwn(
          target?.settings.projectSettingsOverrides[candidate.projectId]?.disabledSkills ?? {},
          name,
        ),
    );

  /**
   * The environments in scope that lack a skill and can take a copy of it:
   * the user's own skills only, onto environments that let this client
   * manage providers.
   */
  const syncTargetsOf = (row: SkillRow) => {
    if (!fleet || (row.group !== "project" && row.group !== "personal")) return [];
    const { on } = fleetOf(row);
    return environments.filter(
      (environment) =>
        !on.includes(environment.environmentId) &&
        installers.has(environment.environmentId) &&
        (row.group === "personal" || environment.cwd !== null),
    );
  };
  const syncOf = (row: SkillRow) => {
    const missing = syncTargetsOf(row);
    const { environmentId: from } = fleetOf(row);
    const removable = detailsOf(row).removable;
    if (missing.length === 0 || removable === null || syncing.has(row.name)) return null;
    return () => void syncSkill(row.name, from, removable, missing);
  };
  const syncSkill = async (
    name: string,
    from: EnvironmentId,
    level: SkillInstallTarget,
    to: ReadonlyArray<SkillEnvironment>,
  ) => {
    setSkillActionError(null);
    setSyncing((current) => new Set([...current, name]));
    try {
      const bundle = await exportSkill({ environmentId: from, input: { name, target: level } });
      if (bundle._tag === "Failure") {
        setSkillActionError(
          `Couldn't copy ${name} from ${environmentLabel(from)}: ${formatEnvironmentQueryError(bundle.cause)}`,
        );
        return;
      }
      const failures = await Promise.all(
        to.map(async (environment) => {
          const result = await importSkill({
            environmentId: environment.environmentId,
            input: {
              bundle: bundle.value,
              // Project skills go into the project's checkout on each environment.
              target:
                level.kind === "project" && environment.cwd !== null
                  ? { kind: "project", cwd: environment.cwd }
                  : { kind: "environment" },
            },
          });
          return result._tag === "Failure"
            ? `${environment.label}: ${formatEnvironmentQueryError(result.cause)}`
            : null;
        }),
      );
      const messages = failures.filter((message) => message !== null);
      if (messages.length > 0) setSkillActionError(`Couldn't copy ${name}. ${messages.join(" ")}`);
    } finally {
      setSyncing((current) => {
        const next = new Set(current);
        next.delete(name);
        return next;
      });
      afterSkillChange();
    }
  };

  /** Update and remove reach every environment in scope that has the skill. */
  const actionTargetsOf = (row: SkillRow, kind: "update" | "remove"): ReadonlyArray<SkillAction> =>
    fleetOf(row).on.flatMap((id) => {
      if (!installers.has(id)) return [];
      const environmentRow = collectSkillRows(
        environmentProviders.find((entry) => entry.environmentId === id)?.providers ??
          EMPTY_PROVIDERS,
        environments.find((environment) => environment.environmentId === id)?.cwd ?? null,
      ).find((candidate) => candidate.name.toLowerCase() === row.name.toLowerCase());
      if (environmentRow === undefined) return [];
      const details = skillRowDetails(environmentRow, foldersOf(id));
      const level = kind === "update" ? details.installed?.target : details.removable;
      return level === undefined || level === null
        ? []
        : [{ environmentId: id, name: environmentRow.name, target: level }];
    });
  const updateOf = (row: SkillRow) => {
    const inputs = actionTargetsOf(row, "update");
    return inputs.length === 0 ? null : () => void runSkillAction("update", inputs);
  };
  const removeOf = (row: SkillRow) => {
    const inputs = actionTargetsOf(row, "remove");
    if (inputs.length === 0) return null;
    const installed = detailsOf(row).installed !== null;
    return () => setRemovingSkill({ name: row.name, inputs, installed });
  };
  const listItem = (row: SkillRow): SkillListRow => ({
    row,
    details: detailsOf(row),
    disabled: isSkillDisabled(disabledSkills, row.name),
    overridden: projectOverrides(row.name),
    ...(fleet ? { on: fleetOf(row).on } : {}),
  });

  const opened = openName === null ? null : (rows.find((row) => row.name === openName) ?? null);
  const showSkeleton = useAfterDelay(rows.length === 0 && refreshing, SKELETON_DELAY_MS);

  return (
    <>
      {opened !== null && environmentId !== null ? (
        <SkillDetail
          key={opened.name}
          row={opened}
          details={detailsOf(opened)}
          agents={agentsByEnvironment.get(fleetOf(opened).environmentId) ?? agents}
          environmentId={fleetOf(opened).environmentId}
          {...(fleet
            ? {
                fleet: {
                  on: fleetOf(opened).on,
                  environments,
                  shownFrom: fleetOf(opened).environmentId,
                },
              }
            : {})}
          onBack={() => onOpen(null)}
          onUpdate={updateOf(opened)}
          onRemove={removeOf(opened)}
          onSync={syncOf(opened)}
          syncing={syncing.has(opened.name)}
        />
      ) : openName !== null ? (
        // A link or Back to a skill that isn't here (yet, or any more).
        <SettingsSection title="Skills">
          <SettingsRow
            title={
              refreshing || rows.length === 0
                ? "Loading skills…"
                : `No skill named “${openName}” here.`
            }
          />
        </SettingsSection>
      ) : (
        <>
          <SettingsSection
            {...searchableSetting("tools-skills")}
            hideTitle
            variant="plain"
            className="px-3 sm:px-4"
          >
            <div className="flex flex-wrap items-center gap-2">
              {tabs}
              <InputGroup className="min-w-48 flex-1">
                <InputGroupAddon>
                  <SearchIcon />
                </InputGroupAddon>
                <InputGroupInput
                  size="sm"
                  placeholder="Search skills…"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  aria-label="Search skills"
                />
              </InputGroup>
              {attentionNames.size > 0 || onlyAttention ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="sm"
                        variant={onlyAttention ? "secondary" : "outline"}
                        aria-pressed={onlyAttention}
                        aria-label={`Show only skills whose name is used more than once (${attentionNames.size})`}
                        onClick={() => setOnlyAttention((value) => !value)}
                      />
                    }
                  >
                    <AlertTriangleIcon aria-hidden className="text-warning-foreground" />
                    {attentionNames.size}
                  </TooltipTrigger>
                  <TooltipPopup side="top" className="max-w-xs">
                    {onlyAttention
                      ? "Show all skills."
                      : "Show only skills whose name is used by different skills. One switch turns all of them on or off."}
                  </TooltipPopup>
                </Tooltip>
              ) : null}
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-sm"
                      variant="outline"
                      aria-label={refreshing ? "Rescanning skills" : "Rescan skills"}
                      disabled={refreshing || environmentId === null}
                      onClick={() => void refresh(true)}
                    />
                  }
                >
                  <RefreshIcon refreshing={refreshing} />
                </TooltipTrigger>
                <TooltipPopup side="top">Rescan skill folders</TooltipPopup>
              </Tooltip>
              {installTarget !== null && canInstall ? (
                <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
                  <PlusIcon className="size-3.5" aria-hidden />
                  Add skills
                </Button>
              ) : null}
            </div>
            {skillActionError !== null ? (
              <p className="mt-2 text-xs text-destructive-foreground">{skillActionError}</p>
            ) : null}
          </SettingsSection>
          {showSkeleton ? <SkillsSkeleton /> : null}
          {rows.length === 0 && !refreshing ? (
            <SettingsSection title="Skills">
              <SettingsRow
                title="No skills yet"
                description="Agents load skills from folders like ~/.agents/skills and .claude/skills. Add skills from a source, or put one there and rescan."
              />
            </SettingsSection>
          ) : rows.length > 0 && groups.length === 0 ? (
            <SettingsSection title="Skills">
              <SettingsRow
                title={
                  onlyAttention && query.trim() === ""
                    ? "No two skills share a name."
                    : `No skills match “${query.trim()}”`
                }
              />
            </SettingsSection>
          ) : (
            groups.map(({ group, rows: groupRows }) => (
              <SkillListSection
                key={group}
                title={SKILL_GROUP_LABELS[group]}
                hint={SKILL_GROUP_HINTS[group]}
                total={totals.get(group) ?? groupRows.length}
                groups={splitRowsBySource(
                  groupRows.map(listItem),
                  (item) => item.details.installed?.source ?? null,
                )}
                emptyText="No matching skills."
                agents={agents}
                environments={environments}
                canWrite={canWrite}
                onToggle={(skillRows, enabled) => setSkillsDisabled(skillRows, !enabled)}
                onOpen={onOpen}
              />
            ))
          )}
          <p className="px-3 text-xs text-muted-foreground sm:px-4">
            Turning a skill off hides it from Claude, Codex and OpenCode, and from the composer's
            skill menu. Other agents may still load it on their own. Changes apply to new sessions.
          </p>
        </>
      )}
      {adding && environmentId !== null && installTarget !== null ? (
        <AddSkillsDialog
          open
          onOpenChange={setAdding}
          environmentId={environmentId}
          target={installTarget}
          scopeLabel={scopeLabel}
          onInstalled={afterSkillChange}
        />
      ) : null}
      <AlertDialog
        open={removingSkill !== null}
        onOpenChange={(open) => !open && setRemovingSkill(null)}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removingSkill?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {removingSkill?.installed ? (
                <>
                  Deletes the skill's folder and every agent's link to it, as{" "}
                  <code>npx skills remove</code> does
                </>
              ) : (
                `Deletes ${removingSkill?.name ?? "the skill"} from every agent's skill folder`
              )}
              {removingSkill !== null && removingSkill.inputs.length > 1
                ? ` on ${removingSkill.inputs.map((input) => environmentLabel(input.environmentId)).join(", ")}.`
                : removingSkill?.inputs[0]?.target.kind === "project"
                  ? " in this project."
                  : " on this environment."}
              {removingSkill?.installed
                ? ""
                : " It wasn't installed from a source, so it can't be added back from here."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                if (removingSkill) {
                  void runSkillAction("remove", removingSkill.inputs);
                  if (removingSkill.name === openName) onOpen(null);
                }
                setRemovingSkill(null);
              }}
            >
              Remove
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

/** Placeholder rows for a slow first scan, laid out like the sections they stand in for. */
function SkillsSkeleton() {
  return (
    <div aria-hidden className="space-y-2.5">
      <div className="flex min-h-7 items-center px-3 sm:px-4">
        <Skeleton className="h-3.5 w-24" />
      </div>
      <SettingsGroup>
        <ul className="divide-y divide-border/50">
          {[0, 1, 2, 3].map((row) => (
            <li key={row} className="flex items-center gap-3 px-3 py-2.5 sm:px-4">
              <span className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-3.5 w-28" />
                <Skeleton className="h-3 w-3/4" />
              </span>
              <Skeleton shape="pill" className="h-4 w-14" />
            </li>
          ))}
        </ul>
      </SettingsGroup>
    </div>
  );
}

// ── MCP servers ──────────────────────────────────────────────────────

type ServerEditor =
  | { readonly mode: "add" }
  | { readonly mode: "edit"; readonly row: McpServerRow };

function McpServersPanel({
  tabs,
  openName,
  onOpen,
}: {
  tabs: ReactNode;
  openName: string | null;
  onOpen: (name: string | null) => void;
}) {
  const { scope, target, connectedEnvironments } = useSettingsScope();
  const targets = useToolsTargets();
  const persist = usePersistToolsPatch();
  const canWriteSettings = useScopedSettingsWriteAllowed();
  const managers = useEnvironmentsWithScope(connectedEnvironments, AuthProvidersManageScope);
  const canManageServers =
    connectedEnvironments.length > 0 &&
    connectedEnvironments.every((environment) => managers.has(environment.environmentId));
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  const projectId = isProjectScope ? (target?.projectId ?? null) : null;
  const environmentSettings = target
    ? connectedEnvironments.find(
        (environment) => environment.environmentId === target.environmentId,
      )?.serverConfig?.settings
    : undefined;
  const rows = useMemo(
    () =>
      listMcpServerRows({
        environment: environmentSettings?.mcpServers ?? {},
        project:
          projectId === null
            ? null
            : (environmentSettings?.projectSettingsOverrides[projectId]?.mcpServers ?? {}),
      }),
    [environmentSettings, projectId],
  );
  const [editor, setEditor] = useState<ServerEditor | null>(null);
  const [removing, setRemoving] = useState<McpServerRow | null>(null);
  const scopeLabel = isProjectScope
    ? scope.kind === "project" || scope.kind === "checkout"
      ? scope.group.displayName
      : ""
    : scope.kind === "environment"
      ? scope.label
      : "every environment";

  const writeServer = (
    name: string,
    transport: McpServerTransport,
    enabled: boolean,
    previousName?: string,
  ) =>
    persist(({ settings, projectId: targetProject }) => {
      const existing =
        targetProject === null
          ? settings.mcpServers
          : (settings.projectSettingsOverrides[targetProject]?.mcpServers ?? {});
      // An edit changes the server where it exists; it does not create a copy,
      // without the stored secrets, on a target that never had it.
      if (previousName !== undefined && existing[previousName]?.transport === undefined) {
        return null;
      }
      if (targetProject === null) {
        return {
          mcpServers: {
            ...(previousName !== undefined && previousName !== name
              ? { [previousName]: null }
              : {}),
            [name]: { enabled, transport },
          },
        };
      }
      const entries: Record<string, McpServerProjectOverride> = { ...existing };
      if (previousName !== undefined && previousName !== name) delete entries[previousName];
      entries[name] = { enabled, transport };
      return projectOverridePatch(settings, targetProject, "mcpServers", entries);
    });

  const setEnabled = (row: McpServerRow, enabled: boolean) =>
    persist(({ settings, projectId: targetProject }) =>
      mcpServerEnabledPatch(settings, targetProject, row.name, enabled),
    );

  const remove = (row: McpServerRow) =>
    persist(({ settings, projectId: targetProject }) => {
      if (targetProject === null) return { mcpServers: { [row.name]: null } };
      const entries: Record<string, McpServerProjectOverride> = {
        ...settings.projectSettingsOverrides[targetProject]?.mcpServers,
      };
      delete entries[row.name];
      return projectOverridePatch(settings, targetProject, "mcpServers", entries);
    });

  const resetSwitch = (row: McpServerRow) =>
    persist(({ settings, projectId: targetProject }) => {
      if (targetProject === null) return null;
      const entries: Record<string, McpServerProjectOverride> = {
        ...settings.projectSettingsOverrides[targetProject]?.mcpServers,
      };
      delete entries[row.name];
      return projectOverridePatch(settings, targetProject, "mcpServers", entries);
    });

  const ownRows = isProjectScope ? rows.filter((row) => row.origin === "project") : rows;
  const inheritedRows = isProjectScope ? rows.filter((row) => row.origin !== "project") : [];
  const canEditServers = canWriteSettings && canManageServers && targets.length > 0;
  // The environment's own switch is part of the server definition.
  const canSwitchServers = isProjectScope ? canWriteSettings : canEditServers;
  // Inherited servers are edited where they're defined, on the environment.
  const editable = (row: McpServerRow) =>
    canEditServers && (!isProjectScope || row.origin === "project");

  const environmentId = target?.environmentId ?? null;
  const cwd = targets.find((candidate) => candidate.environmentId === environmentId)?.cwd ?? null;
  const isBuiltIn = openName === T3_MCP_SERVER_NAME;
  const opened =
    openName === null || isBuiltIn ? null : (rows.find((row) => row.name === openName) ?? null);

  return (
    <>
      {openName !== null && environmentId !== null && (isBuiltIn || opened !== null) ? (
        <McpServerDetail
          key={openName}
          name={openName}
          row={opened}
          environmentId={environmentId}
          cwd={cwd}
          canSwitch={opened !== null && canSwitchServers}
          onEnabledChange={(enabled) => {
            if (opened !== null) setEnabled(opened, enabled);
          }}
          onEdit={
            opened !== null && editable(opened)
              ? () => setEditor({ mode: "edit", row: opened })
              : null
          }
          onRemove={opened !== null && editable(opened) ? () => setRemoving(opened) : null}
          onReset={
            opened !== null && opened.origin === "project-switch" ? () => resetSwitch(opened) : null
          }
          onBack={() => onOpen(null)}
        />
      ) : openName !== null ? (
        // A link or Back to a server that isn't here (yet, or any more).
        <SettingsSection title="MCP servers">
          <SettingsRow
            title={
              environmentSettings === undefined
                ? "Loading servers…"
                : `No MCP server named “${openName}” here.`
            }
          />
        </SettingsSection>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 px-3 sm:px-4">
            {tabs}
            {canEditServers ? (
              <Button size="sm" variant="outline" onClick={() => setEditor({ mode: "add" })}>
                <PlusIcon className="size-3.5" aria-hidden />
                Add server
              </Button>
            ) : null}
          </div>
          <SettingsSection
            {...searchableSetting("tools-mcp-servers")}
            // The tab already says MCP servers; a project splits its own from inherited ones.
            title={isProjectScope ? "This project" : "MCP servers"}
            hideTitle={!isProjectScope}
          >
            {isProjectScope ? null : <T3McpServerRow onOpen={() => onOpen(T3_MCP_SERVER_NAME)} />}
            {ownRows.length === 0 ? (
              <SettingsRow
                title={isProjectScope ? "No servers just for this project" : "No servers yet"}
                description={
                  isProjectScope
                    ? "Add one here to give only this project's agents a server, or to point a shared server at a different account."
                    : "Servers added here reach every agent, next to the servers each agent already loads from its own config."
                }
              />
            ) : (
              ownRows.map((row) => (
                <McpServerSettingsRow
                  key={row.name}
                  row={row}
                  canSwitch={canSwitchServers}
                  canEdit={editable(row)}
                  onOpen={() => onOpen(row.name)}
                  onEnabledChange={(enabled) => setEnabled(row, enabled)}
                  onEdit={() => setEditor({ mode: "edit", row })}
                  onRemove={() => setRemoving(row)}
                />
              ))
            )}
          </SettingsSection>
          {isProjectScope && inheritedRows.length > 0 ? (
            <SettingsSection title="Inherited">
              {inheritedRows.map((row) => (
                <McpServerSettingsRow
                  key={row.name}
                  row={row}
                  canSwitch={canSwitchServers}
                  canEdit={false}
                  onOpen={() => onOpen(row.name)}
                  onEnabledChange={(enabled) => setEnabled(row, enabled)}
                  {...(row.origin === "project-switch" ? { onReset: () => resetSwitch(row) } : {})}
                />
              ))}
            </SettingsSection>
          ) : null}
          {!canManageServers && connectedEnvironments.length > 0 ? (
            <p className="px-3 text-xs text-muted-foreground sm:px-4">
              Adding, editing or inspecting servers needs permission to manage providers on this
              environment.
            </p>
          ) : (
            <p className="px-3 text-xs text-muted-foreground sm:px-4">
              Servers you add here are given to Claude, Codex, Cursor, OpenCode, Grok and other ACP
              agents. Pi isn't supported yet. Changes apply to new sessions; use Restart agent
              session to pick them up in an open thread. Open a server to see its tools.
            </p>
          )}
        </>
      )}
      {editor ? (
        <McpServerDialog
          open
          onOpenChange={(open) => {
            if (!open) setEditor(null);
          }}
          scopeLabel={scopeLabel}
          initial={
            editor.mode === "edit" ? { name: editor.row.name, config: editor.row.config } : null
          }
          takenNames={
            // Every target, not only the one shown: a name another environment
            // already uses would otherwise overwrite its server and secrets.
            new Set(
              targets
                .flatMap((writeTarget) => {
                  const settings = connectedEnvironments.find(
                    (environment) => environment.environmentId === writeTarget.environmentId,
                  )?.serverConfig?.settings;
                  const servers =
                    writeTarget.projectId === null
                      ? settings?.mcpServers
                      : Object.fromEntries(
                          Object.entries(
                            settings?.projectSettingsOverrides[writeTarget.projectId]?.mcpServers ??
                              {},
                          ).filter(([, entry]) => entry.transport !== undefined),
                        );
                  return Object.keys(servers ?? {});
                })
                .filter((name) => editor.mode === "add" || name !== editor.row.name),
            )
          }
          onSave={({ name, transport }) => {
            writeServer(
              name,
              transport,
              editor.mode === "edit" ? editor.row.config.enabled : true,
              editor.mode === "edit" ? editor.row.name : undefined,
            );
            // A renamed server's page follows it to the new name.
            if (editor.mode === "edit" && editor.row.name === openName && name !== openName) {
              onOpen(name);
            }
            setEditor(null);
          }}
        />
      ) : null}
      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              New agent sessions stop getting this server, and its stored secrets are deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                if (removing) {
                  remove(removing);
                  if (removing.name === openName) onOpen(null);
                }
                setRemoving(null);
              }}
            >
              Remove
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

/** The row's name as a button, so the row opens from the keyboard too; a click bubbles to the row. */
function OpenServerButton({ name, children }: { name: string; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={`Open ${name}`}
      className="flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </button>
  );
}

/** A server row opens the server's page; its controls keep their clicks to themselves. */
const OPEN_ROW_CLASS = "cursor-pointer hover:bg-muted/40";

/**
 * T3 Code's own server, which every session gets so agents can reach threads,
 * the browser and other T3 tools. It isn't a setting, so it can't be switched
 * off; its name is reserved (see `isValidMcpServerName`).
 */
function T3McpServerRow({ onOpen }: { onOpen: () => void }) {
  return (
    <SettingsRow
      onClick={onOpen}
      className={OPEN_ROW_CLASS}
      title={
        <OpenServerButton name={T3_MCP_SERVER_NAME}>
          <span className="truncate">{T3_MCP_SERVER_NAME}</span>
          <Badge variant="outline" size="sm">
            Built in
          </Badge>
        </OpenServerButton>
      }
      description="T3 Code's own tools: threads, tasks, the browser and devices."
      control={
        <span className="flex items-center" onClick={stopRowClick}>
          <Tooltip>
            <TooltipTrigger render={<span className="inline-flex" />}>
              <Switch aria-label="t3-code server" checked disabled />
            </TooltipTrigger>
            <TooltipPopup side="top">Every agent session gets this server.</TooltipPopup>
          </Tooltip>
          <ChevronRightIcon aria-hidden className="ml-2 size-4 shrink-0 text-muted-foreground" />
        </span>
      }
    />
  );
}

function McpServerSettingsRow({
  row,
  canSwitch,
  canEdit,
  onOpen,
  onEnabledChange,
  onEdit,
  onRemove,
  onReset,
}: {
  readonly row: McpServerRow;
  readonly canSwitch: boolean;
  readonly canEdit: boolean;
  readonly onOpen: () => void;
  readonly onEnabledChange: (enabled: boolean) => void;
  readonly onEdit?: () => void;
  readonly onRemove?: () => void;
  readonly onReset?: () => void;
}) {
  const transport = row.config.transport;
  return (
    <SettingsRow
      onClick={onOpen}
      title={
        <OpenServerButton name={row.name}>
          <span className="truncate">{row.name}</span>
          <Badge variant="outline" size="sm">
            {transport.type === "stdio" ? "Command" : "URL"}
          </Badge>
          {row.replacesEnvironment ? (
            <Badge variant="info" size="sm">
              Replaces environment's
            </Badge>
          ) : null}
          {row.origin === "project-switch" ? (
            <Badge variant="info" size="sm">
              {row.config.enabled ? "On" : "Off"} for this project
            </Badge>
          ) : null}
        </OpenServerButton>
      }
      description={
        <span className="break-all font-mono">{mcpServerTransportSummary(transport)}</span>
      }
      className={cn(OPEN_ROW_CLASS, !row.config.enabled && "[&_h3]:text-muted-foreground")}
      control={
        // Menu items render in a portal, but React still bubbles their clicks through here.
        <span className="flex items-center gap-2" onClick={stopRowClick}>
          {onReset ? (
            <Button size="xs" variant="ghost" onClick={onReset} disabled={!canSwitch}>
              Reset
            </Button>
          ) : null}
          {canEdit && onEdit && onRemove ? (
            <Menu>
              <MenuTrigger
                render={
                  <Button size="icon-sm" variant="ghost-muted" aria-label={`${row.name} options`} />
                }
              >
                <MoreHorizontalIcon className="size-4" />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuItem onClick={onEdit}>Edit</MenuItem>
                <MenuItem variant="destructive" onClick={onRemove}>
                  Remove
                </MenuItem>
              </MenuPopup>
            </Menu>
          ) : null}
          <Switch
            aria-label={`${row.name} server`}
            checked={row.config.enabled}
            disabled={!canSwitch}
            onCheckedChange={onEnabledChange}
          />
          <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        </span>
      }
    />
  );
}

export type { McpServerConfig };
