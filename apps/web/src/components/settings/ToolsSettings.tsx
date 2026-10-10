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
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import {
  isSkillDisabled,
  mcpServerEnabledPatch,
  projectOverridePatch,
  skillsDisabledPatch,
} from "@t3tools/shared/agentTools";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { MoreHorizontalIcon, PlusIcon, RefreshCwIcon, SearchIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
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
import { Switch } from "../ui/switch";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AddSkillsDialog } from "./AddSkillsDialog";
import { McpServerDialog } from "./McpServerDialog";
import { SkillFilesDialog } from "./SkillFilesDialog";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  collectSkillRows,
  filterSkillRows,
  groupSkillRows,
  listMcpServerRows,
  type McpServerRow,
  SKILL_GROUP_LABELS,
  skillReachesSomeProviders,
  type SkillRow,
  type SkillRowDetails,
  skillRowDetails,
  splitRowsBySource,
  type ToolsTab,
} from "./toolsSettings.logic";
import { useScopedSettings, useScopedSettingsWriteAllowed } from "./useScopedSettings";

const EMPTY_PROVIDERS: ReadonlyArray<ServerProvider> = [];

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
  const [viewing, setViewing] = useState<{
    readonly name: string;
    readonly folder: SkillFolderInfo;
  } | null>(null);
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
    const result =
      action === "update"
        ? await updateSkill({ environmentId, input })
        : await removeSkill({ environmentId, input });
    afterSkillChange();
    if (result._tag === "Failure") {
      setSkillActionError(
        `Couldn't ${action} ${input.name}: ${formatEnvironmentQueryError(result.cause)}`,
      );
    }
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
  const groups = useMemo(() => groupSkillRows(filterSkillRows(rows, query)), [query, rows]);
  const detailsByName = useMemo(
    () => new Map(rows.map((row) => [row.name, skillRowDetails(row, foldersByPath)])),
    [foldersByPath, rows],
  );
  const detailsOf = (row: SkillRow) =>
    detailsByName.get(row.name) ?? skillRowDetails(row, foldersByPath);

  const setSkillsDisabled = (skillRows: ReadonlyArray<SkillRow>, disabled: boolean) =>
    persist(({ settings, projectId }) =>
      skillsDisabledPatch(
        settings,
        projectId,
        skillRows.map((row) => row.name),
        disabled,
      ),
    );
  const setSkillDisabled = (name: string, disabled: boolean) => {
    const row = rows.find((candidate) => candidate.name === name);
    if (row !== undefined) setSkillsDisabled([row], disabled);
  };

  return (
    <>
      <SettingsSection
        {...searchableSetting("tools-skills")}
        hideTitle
        variant="plain"
        className="px-3 sm:px-4"
      >
        <div className="flex items-center gap-2">
          <InputGroup className="min-w-0 flex-1">
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput
              size="sm"
              placeholder="Filter skills"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Filter skills"
            />
          </InputGroup>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="outline"
                  aria-label="Rescan skills"
                  disabled={refreshing || environmentId === null}
                  onClick={() => void refresh(true)}
                />
              }
            >
              <RefreshCwIcon className={refreshing ? "size-3.5 animate-spin" : "size-3.5"} />
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
      {rows.length === 0 ? (
        <SettingsSection title="Skills">
          <SettingsRow
            title={refreshing ? "Looking for skills…" : "No skills found"}
            description={
              refreshing
                ? undefined
                : "Agents load skills from folders like ~/.agents/skills and .claude/skills. Add one there and rescan."
            }
          />
        </SettingsSection>
      ) : groups.length === 0 ? (
        <SettingsSection title="Skills">
          <SettingsRow title={`No skills match “${query.trim()}”`} />
        </SettingsSection>
      ) : (
        groups.map(({ group, rows: groupRows }) => (
          <SettingsSection key={group} title={SKILL_GROUP_LABELS[group]}>
            {splitRowsBySource(groupRows, (row) => detailsOf(row).installed?.source ?? null).map(
              ({ source, rows: sourceRows }) => {
                const renderRow = (row: SkillRow) => {
                  const details = detailsOf(row);
                  const { folder, installed } = details;
                  return (
                    <SkillSettingsRow
                      key={row.name}
                      row={row}
                      details={details}
                      disabled={isSkillDisabled(disabledSkills, row.name)}
                      overridden={
                        isProjectScope &&
                        targets.some(
                          (candidate) =>
                            candidate.projectId !== null &&
                            Object.hasOwn(
                              target?.settings.projectSettingsOverrides[candidate.projectId]
                                ?.disabledSkills ?? {},
                              row.name,
                            ),
                        )
                      }
                      showProviders={skillReachesSomeProviders(row, enabledProviders.length)}
                      canWrite={canWrite}
                      onChange={(enabled) => setSkillDisabled(row.name, !enabled)}
                      onView={folder === null ? null : () => setViewing({ name: row.name, folder })}
                      onUpdate={
                        installed === null || !canInstall
                          ? null
                          : () =>
                              void runSkillAction("update", {
                                name: row.name,
                                target: installed.target,
                              })
                      }
                      onRemove={
                        installed === null || !canInstall
                          ? null
                          : () => setRemovingSkill({ name: row.name, target: installed.target })
                      }
                    />
                  );
                };
                if (source === null) return sourceRows.map(renderRow);
                const allOff = sourceRows.every((row) => isSkillDisabled(disabledSkills, row.name));
                return (
                  <div key={`source:${source}`} className="border-t first:border-t-0">
                    <SettingsRow
                      title={
                        <span className="text-muted-foreground">
                          From <span className="font-mono text-foreground">{source}</span>
                        </span>
                      }
                      control={
                        <Switch
                          aria-label={`Skills from ${source}`}
                          checked={!allOff}
                          disabled={!canWrite}
                          onCheckedChange={(enabled) => setSkillsDisabled(sourceRows, !enabled)}
                        />
                      }
                    />
                    <div className="ps-4">{sourceRows.map(renderRow)}</div>
                  </div>
                );
              },
            )}
          </SettingsSection>
        ))
      )}
      <p className="px-3 text-xs text-muted-foreground sm:px-4">
        Turning a skill off hides it from Claude, Codex and OpenCode, and from the composer's skill
        menu. Other agents may still load it on their own. Changes apply to new sessions.
      </p>
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
      {viewing !== null && environmentId !== null ? (
        <SkillFilesDialog
          open
          onOpenChange={(open) => {
            if (!open) setViewing(null);
          }}
          environmentId={environmentId}
          name={viewing.name}
          folder={viewing.folder}
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
                if (removingSkill) void runSkillAction("remove", removingSkill);
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

function SkillSettingsRow({
  row,
  details,
  disabled,
  overridden,
  showProviders,
  canWrite,
  onChange,
  onView,
  onUpdate,
  onRemove,
}: {
  readonly row: SkillRow;
  readonly details: SkillRowDetails;
  readonly disabled: boolean;
  readonly overridden: boolean;
  readonly showProviders: boolean;
  readonly canWrite: boolean;
  readonly onChange: (enabled: boolean) => void;
  readonly onView: (() => void) | null;
  readonly onUpdate: (() => void) | null;
  readonly onRemove: (() => void) | null;
}) {
  const lockedOff = row.disabledByProvider;
  return (
    <SettingsRow
      title={
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-mono">{row.name}</span>
          {overridden ? (
            <Badge variant="info" size="sm">
              This project
            </Badge>
          ) : null}
          {details.conflict ? (
            <Tooltip>
              <TooltipTrigger render={<span className="inline-flex" />}>
                <Badge variant="warning" size="sm">
                  Conflict
                </Badge>
              </TooltipTrigger>
              <TooltipPopup side="top" className="max-w-sm">
                Different skills share this name. The switch turns all of them on or off:
                {row.paths.map((path) => (
                  <span key={path} className="block truncate font-mono">
                    {path}
                  </span>
                ))}
              </TooltipPopup>
            </Tooltip>
          ) : null}
        </span>
      }
      description={
        lockedOff
          ? "Turned off in the agent's own settings."
          : (row.description ?? row.paths[0] ?? undefined)
      }
      className={disabled || lockedOff ? "[&_h3]:text-muted-foreground" : undefined}
      control={
        <>
          {showProviders ? (
            <span className="flex items-center gap-1">
              {row.providers.map((provider) => (
                <Tooltip key={provider.instanceId}>
                  <TooltipTrigger render={<span className="inline-flex" />}>
                    <ProviderInstanceIcon
                      driverKind={provider.driver}
                      displayName={provider.displayName}
                      badgeContent="none"
                      className="size-4"
                    />
                  </TooltipTrigger>
                  <TooltipPopup side="top">{provider.displayName}</TooltipPopup>
                </Tooltip>
              ))}
            </span>
          ) : null}
          <Switch
            aria-label={`${row.name} skill`}
            checked={!disabled && !lockedOff}
            disabled={!canWrite || lockedOff}
            onCheckedChange={onChange}
          />
          {onView !== null || onUpdate !== null || onRemove !== null ? (
            <Menu>
              <MenuTrigger
                render={
                  <Button size="icon-sm" variant="ghost-muted" aria-label={`${row.name} options`} />
                }
              >
                <MoreHorizontalIcon className="size-4" />
              </MenuTrigger>
              <MenuPopup align="end">
                {onView !== null ? <MenuItem onClick={onView}>View files</MenuItem> : null}
                {onUpdate !== null ? <MenuItem onClick={onUpdate}>Update</MenuItem> : null}
                {onRemove !== null ? (
                  <MenuItem variant="destructive" onClick={onRemove}>
                    Remove
                  </MenuItem>
                ) : null}
              </MenuPopup>
            </Menu>
          ) : null}
        </>
      }
    />
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
