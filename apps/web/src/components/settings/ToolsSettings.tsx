import {
  AuthProvidersManageScope,
  requiredScopesForServerSettingsPatch,
  type EnvironmentId,
  mcpServerTransportSummary,
  type McpServerProjectOverride,
  type McpServerTransport,
  type ProjectId,
  type ServerProvider,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { toastManager } from "../ui/toast";
import { MoreHorizontalIcon, PlusIcon, RefreshCwIcon, SearchIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";
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
import { WebToolsPanel } from "./WebSettings";
import {
  collectSkillRows,
  filterSkillRows,
  groupSkillRows,
  isSkillDisabled,
  listMcpServerRows,
  mcpServerForTarget,
  mcpServerTransportForTarget,
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
  readonly supportsAgentTools: boolean;
}

function useToolsTargets(): ReadonlyArray<ToolsTarget> {
  const { scope, connectedEnvironments } = useSettingsScope();
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
              supportsAgentTools:
                environment.serverConfig?.environment.capabilities.agentTools === true,
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
    supportsAgentTools: environment.serverConfig?.environment.capabilities.agentTools === true,
  }));
}

type ToolsSettingsSnapshot = NonNullable<
  ReturnType<typeof useSettingsScope>["connectedEnvironments"][number]["serverConfig"]
>["settings"];

function usePersistToolsPatch() {
  const targets = useToolsTargets();
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "update tools",
  });
  const queues = useRef(new Map<EnvironmentId, Promise<void>>());
  const written = useRef(
    new Map<
      string,
      { readonly base: ToolsSettingsSnapshot; readonly next: ToolsSettingsSnapshot }
    >(),
  );
  return (
    apply: (input: {
      readonly settings: ToolsSettingsSnapshot;
      readonly projectId: ProjectId | null;
    }) => ServerSettingsPatch | null,
  ) => {
    for (const target of targets) {
      const save = async () => {
        const config = appAtomRegistry.get(serverEnvironment.configValueAtom(target.environmentId));
        if (!config?.environment.capabilities.agentTools) {
          toastManager.add({
            type: "warning",
            title: "Tools not saved",
            description: `Update ${target.label} to manage skills and MCP servers.`,
          });
          return;
        }
        const pushed = config.settings;
        const pending = written.current.get(target.environmentId);
        const settings = pending?.base === pushed ? pending.next : pushed;
        let patch: ServerSettingsPatch | null;
        try {
          patch = apply({ settings, projectId: target.projectId });
        } catch (error) {
          toastManager.add({
            type: "warning",
            title: "Tools not saved",
            description: error instanceof Error ? error.message : "Could not update tools.",
          });
          return;
        }
        if (patch === null) return;
        const missing = requiredScopesForServerSettingsPatch(patch, settings).find(
          (scope) => !readEnvironmentScope(target.environmentId, scope),
        );
        if (missing) {
          toastManager.add({
            type: "warning",
            title: "Tools not saved",
            description: `This connection lacks permission to change tools on ${target.label}.`,
          });
          return;
        }
        const result = await updateSettings({
          environmentId: target.environmentId,
          input: { patch },
        });
        if (result._tag === "Failure") {
          written.current.delete(target.environmentId);
          return;
        }
        written.current.set(target.environmentId, {
          base: pushed,
          next: result.value,
        });
      };
      const next = (queues.current.get(target.environmentId) ?? Promise.resolve()).then(save);
      queues.current.set(target.environmentId, next);
      void next.finally(() => {
        if (queues.current.get(target.environmentId) === next)
          queues.current.delete(target.environmentId);
      });
    }
  };
}

function projectOverridePatch<K extends "mcpServers" | "disabledSkills">(
  settings: {
    readonly projectSettingsOverrides: Readonly<Record<string, Record<string, unknown>>>;
  },
  projectId: ProjectId,
  key: K,
  value: Readonly<Record<string, unknown>>,
): ServerSettingsPatch {
  return {
    projectSettingsOverrides: {
      [projectId]: { ...settings.projectSettingsOverrides[projectId], [key]: value },
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
  const unsupported = useToolsTargets().filter((target) => !target.supportsAgentTools);
  return (
    <SettingsPageContainer>
      <div className="px-3 sm:px-4">
        <ToggleGroup
          aria-label="Tools"
          variant="segmented"
          value={[tab]}
          onValueChange={(next) => {
            const value = next[0];
            if (value === "skills" || value === "mcp" || value === "web") selectTab(value);
          }}
        >
          <Toggle value="skills">Skills</Toggle>
          <Toggle value="mcp">MCP servers</Toggle>
          <Toggle value="web">Web</Toggle>
        </ToggleGroup>
      </div>
      {unsupported.length > 0 ? (
        <SettingsSection title="Update environment">
          <SettingsRow
            title="Tools settings need a newer server"
            description={`Update ${[...new Set(unsupported.map((target) => target.label))].join(", ")} to manage skills and MCP servers for this scope.`}
          />
        </SettingsSection>
      ) : tab === "mcp" ? (
        <McpServersPanel />
      ) : tab === "web" ? (
        <WebToolsPanel />
      ) : (
        <SkillsPanel />
      )}
    </SettingsPageContainer>
  );
}

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
  const enabledProviders = providers.filter((provider) => provider.enabled);
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";

  const refresh = async (fresh: boolean) => {
    if (environmentId === null) return;
    setRefreshing(true);
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
    setRefreshing(false);
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

  const rows = collectSkillRows(providers, cwd);
  const groups = groupSkillRows(filterSkillRows(rows, query));

  const setSkillDisabled = (name: string, disabled: boolean) =>
    persist(({ settings, projectId }) => {
      if (projectId === null) {
        return { disabledSkills: [...withSkillDisabled(settings.disabledSkills, name, disabled)] };
      }
      const switches = { ...settings.projectSettingsOverrides[projectId]?.disabledSkills };
      const inheritedOff = isSkillDisabled(settings.disabledSkills, name);
      for (const key of Object.keys(switches)) {
        if (key.toLowerCase() === name.toLowerCase()) delete switches[key];
      }
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
        Turning a skill off hides it from Claude, Codex and OpenCode 1, and from the composer's
        skill menu. Cursor, Grok, Antigravity, Pi, Muse and OpenCode 2 may still load it on their
        own. Changes apply to new sessions.
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
  const rows = listMcpServerRows({
    environment: environmentSettings?.mcpServers ?? {},
    project:
      projectId === null
        ? null
        : (environmentSettings?.projectSettingsOverrides[projectId]?.mcpServers ?? {}),
  });
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
  ) => {
    const initial = editor?.mode === "edit" ? editor.row.config.transport : undefined;
    const renamedFrom = previousName !== name ? previousName : undefined;
    try {
      for (const target of targets) {
        const settings = connectedEnvironments.find(
          (environment) => environment.environmentId === target.environmentId,
        )?.serverConfig?.settings;
        const existing =
          target.projectId === null
            ? settings?.mcpServers
            : settings?.projectSettingsOverrides[target.projectId]?.mcpServers;
        const destination = existing?.[previousName ?? name]?.transport;
        if (destination) mcpServerTransportForTarget(transport, initial, destination, renamedFrom);
      }
    } catch (error) {
      toastManager.add({
        type: "warning",
        title: "Tools not saved",
        description: error instanceof Error ? error.message : "Could not update tools.",
      });
      return false;
    }
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
      const targetConfig = mcpServerForTarget(
        { enabled, transport },
        initial,
        existing[previousName ?? name],
        renamedFrom,
      );
      if (targetProject === null) {
        return {
          mcpServers: {
            ...(previousName !== undefined && previousName !== name
              ? { [previousName]: null }
              : {}),
            [name]: targetConfig,
          },
        };
      }
      const entries: Record<string, McpServerProjectOverride> = { ...existing };
      if (previousName !== undefined && previousName !== name) delete entries[previousName];
      entries[name] = targetConfig;
      return projectOverridePatch(settings, targetProject, "mcpServers", entries);
    });
    return true;
  };

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
  const canEditServers =
    canManageServers && targets.length > 0 && (!isProjectScope || canWriteSettings);

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
                : "Servers added here reach supported agents, next to the servers each agent already loads from its own config."
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
          agents. Pi, Muse and external OpenCode 1 servers aren't supported. Changes apply to new
          sessions; use Restart agent session to pick them up in an open thread.
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
            const saved = writeServer(
              name,
              transport,
              editor.mode === "edit" ? editor.row.config.enabled : true,
              editor.mode === "edit" ? editor.row.name : undefined,
            );
            if (saved) setEditor(null);
          }}
        />
      ) : null}
      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {removing?.replacesEnvironment
                ? "New agent sessions use the environment configuration again, and this project's stored secrets are deleted. To stop using this server, turn off its inherited project switch."
                : "New agent sessions stop getting this server, and its stored secrets are deleted."}
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
