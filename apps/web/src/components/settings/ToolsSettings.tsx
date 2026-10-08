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
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { MoreHorizontalIcon, PlusIcon, RefreshCwIcon, SearchIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
import { McpServerDialog } from "./McpServerDialog";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  collectSkillRows,
  filterSkillRows,
  groupSkillRows,
  isSkillDisabled,
  listMcpServerRows,
  type McpServerRow,
  SKILL_GROUP_LABELS,
  skillReachesSomeProviders,
  type SkillRow,
  type ToolsTab,
  withSkillDisabled,
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

/**
 * Write a Tools change to every target. `apply` receives the target's raw
 * environment settings and returns its patch: the environment's own key at
 * environment scope, or the project's override entry at project scope.
 */
function usePersistToolsPatch() {
  const targets = useToolsTargets();
  const { connectedEnvironments } = useSettingsScope();
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "update tools",
  });
  return useCallback(
    (
      apply: (input: {
        readonly settings: NonNullable<
          (typeof connectedEnvironments)[number]["serverConfig"]
        >["settings"];
        readonly projectId: ProjectId | null;
      }) => ServerSettingsPatch | null,
    ) => {
      for (const target of targets) {
        const settings = connectedEnvironments.find(
          (environment) => environment.environmentId === target.environmentId,
        )?.serverConfig?.settings;
        if (!settings) continue;
        const patch = apply({ settings, projectId: target.projectId });
        if (patch === null) continue;
        void updateSettings({ environmentId: target.environmentId, input: { patch } });
      }
    },
    [connectedEnvironments, targets, updateSettings],
  );
}

/** Replace one key of a project's override entry, dropping the key (or the entry) when empty. */
function projectOverridePatch<K extends "mcpServers" | "disabledSkills">(
  settings: {
    readonly projectSettingsOverrides: Readonly<Record<string, Record<string, unknown>>>;
  },
  projectId: ProjectId,
  key: K,
  value: Readonly<Record<string, unknown>>,
): ServerSettingsPatch {
  const { [key]: _previous, ...rest } = settings.projectSettingsOverrides[projectId] ?? {};
  const next = Object.keys(value).length === 0 ? rest : { ...rest, [key]: value };
  return {
    projectSettingsOverrides: {
      [projectId]: Object.keys(next).length === 0 ? null : next,
    },
  } as ServerSettingsPatch;
}

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

  const setSkillDisabled = (name: string, disabled: boolean) =>
    persist(({ settings, projectId }) => {
      if (projectId === null) {
        return { disabledSkills: [...withSkillDisabled(settings.disabledSkills, name, disabled)] };
      }
      const switches = { ...settings.projectSettingsOverrides[projectId]?.disabledSkills };
      const inheritedOff = isSkillDisabled(settings.disabledSkills, name);
      delete switches[name];
      // A switch that matches the environment is not an override.
      if (disabled !== inheritedOff) switches[name] = disabled;
      return projectOverridePatch(settings, projectId, "disabledSkills", switches);
    });

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
        </div>
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
            {groupRows.map((row) => (
              <SkillSettingsRow
                key={row.name}
                row={row}
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
              />
            ))}
          </SettingsSection>
        ))
      )}
      <p className="px-3 text-xs text-muted-foreground sm:px-4">
        Turning a skill off hides it from Claude, Codex and OpenCode, and from the composer's skill
        menu. Other agents may still load it on their own. Changes apply to new sessions.
      </p>
    </>
  );
}

function SkillSettingsRow({
  row,
  disabled,
  overridden,
  showProviders,
  canWrite,
  onChange,
}: {
  readonly row: SkillRow;
  readonly disabled: boolean;
  readonly overridden: boolean;
  readonly showProviders: boolean;
  readonly canWrite: boolean;
  readonly onChange: (enabled: boolean) => void;
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
      const entries: Record<string, McpServerProjectOverride> = {
        ...settings.projectSettingsOverrides[targetProject]?.mcpServers,
      };
      if (previousName !== undefined && previousName !== name) delete entries[previousName];
      entries[name] = { enabled, transport };
      return projectOverridePatch(settings, targetProject, "mcpServers", entries);
    });

  const setEnabled = (row: McpServerRow, enabled: boolean) =>
    persist(({ settings, projectId: targetProject }) => {
      if (targetProject === null) {
        const current = settings.mcpServers[row.name];
        return current ? { mcpServers: { [row.name]: { ...current, enabled } } } : null;
      }
      const entries: Record<string, McpServerProjectOverride> = {
        ...settings.projectSettingsOverrides[targetProject]?.mcpServers,
      };
      const own = entries[row.name];
      const inherited = settings.mcpServers[row.name];
      if (own?.transport !== undefined) {
        entries[row.name] = { ...own, enabled };
      } else if (inherited !== undefined && inherited.enabled === enabled) {
        // Back to the environment's value: no override needed.
        delete entries[row.name];
      } else {
        entries[row.name] = { enabled };
      }
      return projectOverridePatch(settings, targetProject, "mcpServers", entries);
    });

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
              canSwitch={canWriteSettings}
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
            new Set(
              rows
                .filter((row) => editor.mode === "add" || row.name !== editor.row.name)
                .filter((row) => !isProjectScope || row.origin === "project")
                .map((row) => row.name),
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
