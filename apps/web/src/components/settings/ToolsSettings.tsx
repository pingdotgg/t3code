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
  type SkillInstallTarget,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import {
  isSkillDisabled,
  mcpServerEnabledPatch,
  projectOverridePatch,
  skillsDisabledPatch,
} from "@t3tools/shared/agentTools";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { MoreHorizontalIcon, PlusIcon, SearchIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAfterDelay } from "../../hooks/useAfterDelay";
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
import { McpServerDialog } from "./McpServerDialog";
import { SettingsGroup } from "./SettingsGroup";
import { SkillDetail } from "./SkillDetail";
import { SkillListSection, type SkillListRow } from "./SkillList";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  collectSkillRows,
  filterSkillRows,
  groupSkillRows,
  listMcpServerRows,
  type McpServerRow,
  SKILL_GROUP_HINTS,
  SKILL_GROUP_LABELS,
  skillAgents,
  skillAttention,
  type SkillGroupKind,
  type SkillRow,
  skillRowDetails,
  splitRowsBySource,
  type ToolsTab,
} from "./toolsSettings.logic";
import { useScopedSettings, useScopedSettingsWriteAllowed } from "./useScopedSettings";

const EMPTY_PROVIDERS: ReadonlyArray<ServerProvider> = [];
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

/**
 * Replace one key of a project's override entry, dropping the key (or the entry) when empty.
 * The rest of the entry is resent as stored, since the patch replaces the whole entry.
 */
export function ToolsSettings({
  tab = "skills",
  onTabChange,
}: {
  readonly tab?: ToolsTab;
  readonly onTabChange: (tab: ToolsTab) => void;
}) {
  const selectTab = onTabChange;
  return (
    <SettingsPageContainer>
      <div className="px-3 sm:px-4">
        <ToggleGroup
          aria-label="Tools"
          variant="segmented"
          value={[tab]}
          onValueChange={(next) => {
            const value = next[0];
            if (value === "skills" || value === "mcp") selectTab(value);
          }}
        >
          <Toggle value="skills">Skills</Toggle>
          <Toggle value="mcp">MCP servers</Toggle>
        </ToggleGroup>
      </div>
      {tab === "mcp" ? <McpServersPanel /> : <SkillsPanel />}
    </SettingsPageContainer>
  );
}

// ── Skills ───────────────────────────────────────────────────────────

function SkillsPanel() {
  const { scope, target } = useSettingsScope();
  const environmentId = target?.environmentId ?? null;
  const targets = useToolsTargets();
  const cwd = targets.find((candidate) => candidate.environmentId === environmentId)?.cwd ?? null;
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId ?? ("" as EnvironmentId))) ??
    EMPTY_PROVIDERS;
  const disabledSkills = useScopedSettings((settings) => settings.disabledSkills);
  const canWrite = useScopedSettingsWriteAllowed();
  const persist = usePersistToolsPatch();
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const [query, setQuery] = useState("");
  const [onlyAttention, setOnlyAttention] = useState(false);
  // The skill whose page is open in place of the list.
  const [openName, setOpenName] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const enabledProviders = useMemo(
    () => providers.filter((provider) => provider.enabled),
    [providers],
  );
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
  const updateSkill = useAtomCommand(serverEnvironment.updateSkill, { reportFailure: false });
  const removeSkill = useAtomCommand(serverEnvironment.removeSkill, { reportFailure: false });
  const [adding, setAdding] = useState(false);
  const [removingSkill, setRemovingSkill] = useState<{
    readonly name: string;
    readonly target: SkillInstallTarget;
  } | null>(null);
  const [skillActionError, setSkillActionError] = useState<string | null>(null);
  const inspected = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.inspectSkills({
          environmentId,
          input: cwd === null ? {} : { cwd },
        }),
  );
  const foldersByPath = useMemo(
    () => new Map((inspected.data?.folders ?? []).map((folder) => [folder.path, folder])),
    [inspected.data],
  );
  const scopeLabel = isProjectScope
    ? scope.kind === "project" || scope.kind === "checkout"
      ? scope.group.displayName
      : ""
    : scope.kind === "environment"
      ? scope.label
      : "this environment";

  const refresh = async (fresh: boolean) => {
    if (environmentId === null) return;
    setRefreshing(true);
    try {
      await Promise.all(
        enabledProviders.map((provider) =>
          refreshProviders({
            environmentId,
            input: {
              instanceId: provider.instanceId,
              ...(cwd === null ? {} : { cwd }),
              ...(fresh ? { fresh: true } : {}),
            },
          }),
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

  const runSkillAction = async (
    action: "update" | "remove",
    input: { readonly name: string; readonly target: SkillInstallTarget },
  ) => {
    if (environmentId === null) return;
    setSkillActionError(null);
    const failure = async () => {
      if (action === "remove") {
        const result = await removeSkill({ environmentId, input });
        return result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null;
      }
      const result = await updateSkill({ environmentId, input });
      if (result._tag === "Failure") return formatEnvironmentQueryError(result.cause);
      // The CLI reports a skill it couldn't reinstall as a result, not an error.
      const failed = result.value.outcomes.find((outcome) => outcome.status !== "installed");
      return failed === undefined ? null : (failed.error ?? failed.status);
    };
    const message = await failure();
    afterSkillChange();
    if (message !== null) setSkillActionError(`Couldn't ${action} ${input.name}: ${message}`);
  };

  // A project's skills live in its checkout, which each provider only scans
  // when asked; the composer does the same before showing its skill menu.
  // Keyed on the checkout and provider set, not on every status push, which
  // would rescan each time the scan's own result arrives.
  const scanKey = `${environmentId}:${cwd}:${enabledProviders.map((provider) => provider.instanceId).join(",")}`;
  const scannedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (cwd === null || scannedKeyRef.current === scanKey) return;
    scannedKeyRef.current = scanKey;
    void refresh(false);
  }, [cwd, refresh, scanKey]);

  const rows = useMemo(() => collectSkillRows(providers, cwd), [cwd, providers]);
  const agents = useMemo(() => skillAgents(providers), [providers]);
  const detailsByName = useMemo(
    () => new Map(rows.map((row) => [row.name, skillRowDetails(row, foldersByPath)])),
    [foldersByPath, rows],
  );
  const detailsOf = (row: SkillRow) =>
    detailsByName.get(row.name) ?? skillRowDetails(row, foldersByPath);
  const attentionNames = useMemo(
    () =>
      new Set(
        rows
          .filter((row) => {
            const details = detailsByName.get(row.name);
            return details !== undefined && skillAttention(row, details, agents) !== null;
          })
          .map((row) => row.name),
      ),
    [agents, detailsByName, rows],
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
  const listItem = (row: SkillRow): SkillListRow => ({
    row,
    details: detailsOf(row),
    disabled: isSkillDisabled(disabledSkills, row.name),
    overridden: projectOverrides(row.name),
  });
  const updateOf = (row: SkillRow) => {
    const installed = detailsOf(row).installed;
    return installed === null || !canInstall
      ? null
      : () => void runSkillAction("update", { name: row.name, target: installed.target });
  };
  const removeOf = (row: SkillRow) => {
    const installed = detailsOf(row).installed;
    return installed === null || !canInstall
      ? null
      : () => setRemovingSkill({ name: row.name, target: installed.target });
  };

  const opened = openName === null ? null : (rows.find((row) => row.name === openName) ?? null);
  const showSkeleton = useAfterDelay(rows.length === 0 && refreshing, SKELETON_DELAY_MS);

  return (
    <>
      {opened !== null && environmentId !== null ? (
        <SkillDetail
          key={opened.name}
          row={opened}
          details={detailsOf(opened)}
          agents={agents}
          groupLabel={SKILL_GROUP_LABELS[opened.group]}
          environmentId={environmentId}
          onBack={() => setOpenName(null)}
          onUpdate={updateOf(opened)}
          onRemove={removeOf(opened)}
        />
      ) : (
        <>
          <SettingsSection
            {...searchableSetting("tools-skills")}
            hideTitle
            variant="plain"
            className="px-3 sm:px-4"
          >
            <div className="flex flex-wrap items-center gap-2">
              <InputGroup className="w-full min-w-0 sm:w-auto sm:flex-1">
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
              {rows.length > 0 ? (
                <Button
                  size="sm"
                  variant={onlyAttention ? "secondary" : "outline"}
                  aria-pressed={onlyAttention}
                  onClick={() => setOnlyAttention((value) => !value)}
                >
                  Needs attention ({attentionNames.size})
                </Button>
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
                    ? "Nothing needs attention."
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
                canWrite={canWrite}
                onToggle={(skillRows, enabled) => setSkillsDisabled(skillRows, !enabled)}
                onOpen={setOpenName}
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
              Deletes the skill's folder and every agent's link to it, as{" "}
              <code>npx skills remove</code> does.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                if (removingSkill) {
                  void runSkillAction("remove", removingSkill);
                  if (removingSkill.name === openName) setOpenName(null);
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

function McpServersPanel() {
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

  return (
    <>
      <SettingsSection
        {...searchableSetting("tools-mcp-servers")}
        title={isProjectScope ? "This project" : "MCP servers"}
        headerAction={
          canEditServers ? (
            <Button size="xs" variant="outline" onClick={() => setEditor({ mode: "add" })}>
              <PlusIcon className="size-3" aria-hidden />
              Add server
            </Button>
          ) : null
        }
      >
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
              // The environment's own switch is part of the server definition.
              canSwitch={isProjectScope ? canWriteSettings : canEditServers}
              canEdit={canEditServers}
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
              canSwitch={canWriteSettings}
              canEdit={false}
              onEnabledChange={(enabled) => setEnabled(row, enabled)}
              {...(row.origin === "project-switch" ? { onReset: () => resetSwitch(row) } : {})}
            />
          ))}
        </SettingsSection>
      ) : null}
      {!canManageServers && connectedEnvironments.length > 0 ? (
        <p className="px-3 text-xs text-muted-foreground sm:px-4">
          Adding or editing servers needs permission to manage providers on this environment.
        </p>
      ) : (
        <p className="px-3 text-xs text-muted-foreground sm:px-4">
          Servers you add here are given to Claude, Codex, Cursor, OpenCode, Grok and other ACP
          agents. Pi isn't supported yet. Changes apply to new sessions; use Restart agent session
          to pick them up in an open thread.
        </p>
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
                if (removing) remove(removing);
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

function McpServerSettingsRow({
  row,
  canSwitch,
  canEdit,
  onEnabledChange,
  onEdit,
  onRemove,
  onReset,
}: {
  readonly row: McpServerRow;
  readonly canSwitch: boolean;
  readonly canEdit: boolean;
  readonly onEnabledChange: (enabled: boolean) => void;
  readonly onEdit?: () => void;
  readonly onRemove?: () => void;
  readonly onReset?: () => void;
}) {
  const transport = row.config.transport;
  return (
    <SettingsRow
      title={
        <span className="flex min-w-0 items-center gap-1.5">
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
        </span>
      }
      description={
        <span className="break-all font-mono">{mcpServerTransportSummary(transport)}</span>
      }
      className={row.config.enabled ? undefined : "[&_h3]:text-muted-foreground"}
      control={
        <>
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
        </>
      }
    />
  );
}

export type { McpServerConfig };
