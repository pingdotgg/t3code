import type {
  CpaStatus,
  EnvironmentId,
  OptimizerId,
  OptimizerSavingsInterval,
  OptimizerStatus,
  OptimizerStatusSnapshot,
  ProjectId,
} from "@t3tools/contracts";
import { DEFAULT_HEADROOM_PROXY_URL } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { CheckCircle2Icon, CircleAlertIcon, ExternalLinkIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";

const INSTALL_LINKS: Readonly<
  Record<OptimizerId, { readonly label: string; readonly href: string }>
> = {
  rtk: { label: "Install RTK", href: "https://github.com/rtk-ai/rtk" },
  headroom: { label: "Get Headroom", href: "https://extraheadroom.com" },
  cbm: {
    label: "Install CBM",
    href: "https://github.com/DeusData/codebase-memory-mcp",
  },
};

const OPTIMIZER_META: Readonly<
  Record<
    OptimizerId,
    {
      readonly label: string;
      readonly description: string;
      readonly mode: string;
      readonly supportedProviders: string;
    }
  >
> = {
  rtk: {
    label: "RTK",
    description: "Runs as a CLI wrapper inside supported provider sessions.",
    mode: "CLI wrapper",
    supportedProviders:
      "Claude Code (hook and session instructions) and Codex (session instructions)",
  },
  headroom: {
    label: "Headroom",
    description: "Routes supported new sessions through the configured proxy. Start it here.",
    mode: "Session routing",
    supportedProviders: "First-party Claude Code and Codex sessions",
  },
  cbm: {
    label: "Codebase Memory",
    description: "Runs as a stdio MCP server inside supported provider sessions.",
    mode: "stdio MCP",
    supportedProviders: "Claude Code, Codex, Grok, Cursor, Antigravity, and managed OpenCode",
  },
};

const OPTIMIZER_ORDER: readonly OptimizerId[] = ["rtk", "headroom", "cbm"];

function formatTokens(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}

function savingsIntervalLabel(interval: OptimizerSavingsInterval): string {
  switch (interval) {
    case "hour":
      return "Hourly";
    case "day":
      return "Daily";
    case "week":
      return "Weekly";
    case "month":
      return "Monthly";
  }
}

function statusLabel(status: OptimizerStatus | undefined): string {
  if (!status) return "Waiting for probe";
  if (!status.installed) return "Not installed";
  if (status.id === "headroom") {
    return status.running === true ? "Running" : "Installed · not running";
  }
  return "Installed";
}

function statusTone(status: OptimizerStatus | undefined): "success" | "warning" | "secondary" {
  if (!status || !status.installed) return "warning";
  if (status.id === "headroom" && status.running !== true) return "secondary";
  return "success";
}

function StatusIcon({ status }: { readonly status: OptimizerStatus | undefined }) {
  if (status?.installed && (status.id !== "headroom" || status.running === true)) {
    return <CheckCircle2Icon aria-hidden className="size-4 text-success" />;
  }
  return <CircleAlertIcon aria-hidden className="size-4 text-warning" />;
}

function ProviderCompatibilityRow({ id }: { readonly id: OptimizerId }) {
  const meta = OPTIMIZER_META[id];
  const unsupported =
    id === "rtk"
      ? "Cursor, Grok, all OpenCode modes, Antigravity, and Pi are not supported"
      : id === "cbm"
        ? "Managed OpenCode is supported; external OpenCode and Pi are not supported in v1"
        : "Other providers are not routed through Headroom by T3";

  return (
    <SettingsRow
      title={meta.label}
      description={meta.supportedProviders}
      status={unsupported}
      control={<Badge variant="outline">{meta.mode}</Badge>}
    />
  );
}

function OptimizerStatusRows({
  snapshot,
  onStartHeadroom,
  canStartHeadroom,
  startingHeadroom,
  headroomStartError,
}: {
  readonly snapshot: OptimizerStatusSnapshot | null;
  readonly onStartHeadroom: () => void;
  readonly canStartHeadroom: boolean;
  readonly startingHeadroom: boolean;
  readonly headroomStartError: string | null;
}) {
  const statusById = new Map(snapshot?.optimizers.map((status) => [status.id, status]) ?? []);

  return (
    <>
      {OPTIMIZER_ORDER.map((id) => {
        const status = statusById.get(id);
        const meta = OPTIMIZER_META[id];
        const installLink = INSTALL_LINKS[id];
        return (
          <SettingsRow
            key={id}
            title={
              <span className="flex items-center gap-2">
                <StatusIcon status={status} />
                {meta.label}
              </span>
            }
            description={meta.description}
            status={
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <Badge variant={statusTone(status)}>{statusLabel(status)}</Badge>
                {status?.version ? <span>{`v${status.version}`}</span> : null}
                {status?.detail ? <span>{status.detail}</span> : null}
                {id === "headroom" && headroomStartError ? (
                  <span className="text-destructive" role="alert">
                    {headroomStartError}
                  </span>
                ) : null}
              </span>
            }
            control={
              status?.id === "headroom" && status.installed && status.running !== true ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={startingHeadroom || !canStartHeadroom}
                  title={
                    canStartHeadroom ? undefined : "Environment maintenance permission is required."
                  }
                  onClick={onStartHeadroom}
                >
                  {startingHeadroom ? "Starting…" : "Start"}
                </Button>
              ) : status?.installed ? null : (
                <a
                  className="inline-flex items-center gap-1 font-medium text-primary text-xs hover:underline"
                  href={installLink.href}
                  target="_blank"
                  rel="noreferrer"
                >
                  {installLink.label}
                  <ExternalLinkIcon aria-hidden className="size-3" />
                </a>
              )
            }
          />
        );
      })}
    </>
  );
}

function SavingsRows({
  snapshot,
  environmentConnected = true,
}: {
  readonly snapshot: OptimizerStatusSnapshot | null;
  readonly environmentConnected?: boolean;
}) {
  if (!environmentConnected) {
    return (
      <SettingsRow
        title="Savings unavailable"
        description="Reconnect this environment to inspect its host-local counters."
      />
    );
  }
  if (snapshot === null || snapshot.savings.length === 0) {
    return (
      <SettingsRow
        title="No savings reported yet"
        description="Savings appear after the selected environment has processed optimizer-aware work."
      />
    );
  }

  return (
    <>
      {snapshot.savings.map((saving) => (
        <SettingsRow
          key={`${saving.source}:${saving.window}`}
          title={`${OPTIMIZER_META[saving.source].label} · ${saving.window === "all-time" ? "All time" : "This session"}`}
          description="Environment-level savings. These counters are not scoped to this project."
          control={
            <span className="text-sm tabular-nums">{formatTokens(saving.tokensSaved)} tokens</span>
          }
        />
      ))}
    </>
  );
}

function SavingsHistoryRows({
  snapshot,
  environmentConnected = true,
}: {
  readonly snapshot: OptimizerStatusSnapshot | null;
  readonly environmentConnected?: boolean;
}) {
  if (!environmentConnected) {
    return (
      <SettingsRow
        title="Savings history unavailable"
        description="Reconnect this environment to inspect its host-local history."
      />
    );
  }
  const history = snapshot?.savingsHistory ?? [];
  if (history.length === 0) {
    return (
      <SettingsRow
        title="No savings history yet"
        description="Headroom history appears after the selected environment records optimizer-aware work."
      />
    );
  }

  return (
    <>
      {[...history]
        .toSorted((left, right) => right.timestamp.localeCompare(left.timestamp))
        .slice(0, 8)
        .map((point) => (
          <SettingsRow
            key={`${point.interval}:${point.timestamp}`}
            title={`Headroom · ${savingsIntervalLabel(point.interval)}`}
            description={`${new Date(point.timestamp).toLocaleString()} · Environment-level history`}
            control={
              <span className="text-sm tabular-nums">{formatTokens(point.tokensSaved)} tokens</span>
            }
          />
        ))}
    </>
  );
}

function CbmIndexRow({
  projectId,
  snapshot,
}: {
  readonly projectId: ProjectId | null;
  readonly snapshot: OptimizerStatusSnapshot | null;
}) {
  const index =
    projectId === null
      ? null
      : (snapshot?.cbmIndexes.find((candidate) => candidate.projectId === projectId) ?? null);

  if (projectId === null) {
    return (
      <SettingsRow
        title="CBM index"
        description="Choose a project to inspect its codebase-memory index."
        status="No project selected"
      />
    );
  }

  const stateLabel = index
    ? index.state === "ready"
      ? "Ready"
      : index.state === "indexing"
        ? "Indexing"
        : "Degraded"
    : "Not indexed";
  const counts =
    index?.nodeCount !== undefined || index?.edgeCount !== undefined
      ? `${index.nodeCount ?? 0} nodes · ${index.edgeCount ?? 0} edges`
      : undefined;

  return (
    <SettingsRow
      title="CBM index"
      description="The index is scoped to this project. T3 does not delete CBM data."
      status={
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Badge
            variant={
              index?.state === "ready"
                ? "success"
                : index?.state === "degraded"
                  ? "warning"
                  : "secondary"
            }
          >
            {stateLabel}
          </Badge>
          {counts ? <span>{counts}</span> : null}
          {index?.detail ? <span>{index.detail}</span> : null}
        </span>
      }
      control={
        <span className="text-xs text-muted-foreground">
          {index
            ? `Checked ${new Date(index.checkedAt).toLocaleTimeString()}`
            : "No index reported"}
        </span>
      }
    />
  );
}

function CpaRows({
  cpa,
  canManage,
  busy,
  error,
  onStart,
  onSetRouting,
}: {
  readonly cpa: CpaStatus;
  readonly canManage: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onStart: () => void;
  readonly onSetRouting: (enabled: boolean) => void;
}) {
  const permissionTitle = canManage ? undefined : "Environment maintenance permission is required.";
  return (
    <>
      <SettingsRow
        title={
          <span className="flex items-center gap-2">
            {cpa.running ? (
              <CheckCircle2Icon aria-hidden className="size-4 text-success" />
            ) : (
              <CircleAlertIcon aria-hidden className="size-4 text-warning" />
            )}
            CLIProxyAPI
          </span>
        }
        description="Local proxy that serves Claude Code and Codex from its stored accounts."
        status={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Badge variant={cpa.running ? "success" : "secondary"}>
              {cpa.running ? "Running" : "Not running"}
            </Badge>
            <span>{cpa.url}</span>
            {error ? (
              <span className="text-destructive" role="alert">
                {error}
              </span>
            ) : null}
          </span>
        }
        control={
          cpa.running ? (
            <a
              className="inline-flex items-center gap-1 font-medium text-primary text-xs hover:underline"
              href={`${cpa.url}/management.html`}
              target="_blank"
              rel="noreferrer"
            >
              Open dashboard
              <ExternalLinkIcon aria-hidden className="size-3" />
            </a>
          ) : cpa.canStart ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !canManage}
              title={permissionTitle}
              onClick={onStart}
            >
              {busy ? "Starting…" : "Start"}
            </Button>
          ) : null
        }
      />
      <SettingsRow
        title="Route Claude Code and Codex through CPA"
        description="Rewrites this host's Claude settings.json and Codex config.toml, so terminal claude and codex follow it too. Projects with Headroom on chain through Headroom, then CPA."
        status={
          cpa.routing === "partial"
            ? "Partly on: only one of Claude Code or Codex routes through CPA. Turn on to route both."
            : cpa.routing === "on"
              ? "On for new sessions"
              : "Off"
        }
        control={
          <Switch
            checked={cpa.routing === "on"}
            disabled={busy || !canManage}
            title={permissionTitle}
            aria-label="Route Claude Code and Codex through CPA"
            onCheckedChange={onSetRouting}
          />
        }
      />
      {cpa.headroomUpstreamMismatch ? (
        <SettingsRow
          title="Headroom is not pointed at CPA"
          description={`Headroom was started outside T3, so T3 cannot restart it. Restart it with --anthropic-api-url ${cpa.url} --openai-api-url ${cpa.url}/v1, or stop it and start it from Status.`}
          status={<Badge variant="warning">Check Headroom</Badge>}
        />
      ) : null}
    </>
  );
}

function HeadroomProxySettingsRow({
  environmentId,
  environmentConnected,
  proxyUrl,
  onSaved,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentConnected: boolean;
  readonly proxyUrl: string;
  readonly onSaved: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "Headroom proxy URL update",
    reportFailure: false,
  });

  const save = async (value: string) => {
    if (saving || !environmentConnected) return;
    const next = value.trim();
    if (next === proxyUrl) {
      setDraft(null);
      setError(null);
      return;
    }

    setSaving(true);
    setError(null);
    // Atom commands settle to a result rather than rejecting.
    const result = await updateSettings({
      environmentId,
      input: { patch: { headroomProxyUrl: next } },
    }).finally(() => setSaving(false));
    if (result._tag === "Success") {
      setDraft(null);
      onSaved();
    } else if (!isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(
        failure instanceof Error ? failure.message : "Headroom proxy URL could not be saved.",
      );
    }
  };

  const commit = () => {
    if (draft !== null) void save(draft);
  };

  const reset = () => {
    setDraft(DEFAULT_HEADROOM_PROXY_URL);
    void save(DEFAULT_HEADROOM_PROXY_URL);
  };

  return (
    <SettingsRow
      title="Headroom proxy URL"
      description="Loopback base origin of this environment's Headroom proxy, such as http://127.0.0.1:8787 (no /v1). Start an installed proxy from Status. T3 does not install Headroom or change provider config."
      status={error ? <span className="text-destructive">{error}</span> : undefined}
      resetAction={
        proxyUrl !== DEFAULT_HEADROOM_PROXY_URL ? (
          <SettingResetButton
            label="Headroom proxy URL"
            disabled={saving || !environmentConnected}
            onClick={reset}
          />
        ) : null
      }
      control={
        <Input
          size="sm"
          className="w-full sm:w-64"
          value={draft ?? proxyUrl}
          disabled={saving || !environmentConnected}
          aria-label="Headroom proxy URL"
          aria-invalid={error ? true : undefined}
          placeholder={DEFAULT_HEADROOM_PROXY_URL}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) => {
            setDraft(event.currentTarget.value);
            setError(null);
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              event.preventDefault();
              setDraft(null);
              setError(null);
            }
          }}
        />
      }
    />
  );
}

function OptimizerEnvironmentSettings({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const environment = useEnvironments().environments.find(
    (candidate) => candidate.environmentId === environmentId,
  );
  const settings = useEnvironmentSettings(environmentId);
  const projects = useProjects();
  const environmentProjects = projects.filter((project) => project.environmentId === environmentId);
  const [projectSelection, setProjectSelection] = useState<ProjectId | null>(
    environmentProjects[0]?.id ?? null,
  );
  const selectedProjectId =
    projectSelection !== null &&
    environmentProjects.some((project) => project.id === projectSelection)
      ? projectSelection
      : (environmentProjects[0]?.id ?? null);
  const [binaryDraft, setBinaryDraft] = useState<string | null>(null);
  const statusQuery = useEnvironmentQuery(
    environment?.connection.phase === "connected"
      ? serverEnvironment.optimizersGetStatus({
          environmentId,
          input: { refresh: true },
        })
      : null,
  );
  const canStartHeadroom = useAtomValue(
    serverEnvironment.startHeadroom.permissionAtom(environmentId),
  );
  const startHeadroom = useAtomCommand(serverEnvironment.startHeadroom, {
    label: "Headroom proxy start",
    reportFailure: false,
  });
  const [startingHeadroom, setStartingHeadroom] = useState(false);
  const [headroomStartError, setHeadroomStartError] = useState<string | null>(null);
  const canManageCpa = useAtomValue(serverEnvironment.setCpaRouting.permissionAtom(environmentId));
  const startCpa = useAtomCommand(serverEnvironment.startCpa, {
    label: "CLIProxyAPI start",
    reportFailure: false,
  });
  const setCpaRouting = useAtomCommand(serverEnvironment.setCpaRouting, {
    label: "CLIProxyAPI routing",
    reportFailure: false,
  });
  const [cpaBusy, setCpaBusy] = useState(false);
  const [cpaError, setCpaError] = useState<string | null>(null);
  const environmentConnected = environment?.connection.phase === "connected";
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "optimizer setting",
    reportFailure: true,
  });
  const [savingProject, setSavingProject] = useState(false);
  const [savingBinary, setSavingBinary] = useState(false);
  const selectedProject = environmentProjects.find((project) => project.id === selectedProjectId);
  const selectedProjectSettings =
    selectedProjectId === null ? undefined : settings.projectOptimizerOverrides[selectedProjectId];
  const cbmBinaryPath = settings.optimizerBinaryPaths.cbm;

  const startHeadroomProxy = async () => {
    if (!environmentConnected || !canStartHeadroom || startingHeadroom) return;
    setStartingHeadroom(true);
    setHeadroomStartError(null);
    const result = await startHeadroom({ environmentId, input: {} }).finally(() =>
      setStartingHeadroom(false),
    );
    if (result._tag === "Success") {
      statusQuery.refresh();
    } else if (!isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setHeadroomStartError(
        failure instanceof Error ? failure.message : "Headroom could not be started.",
      );
    }
  };

  const runCpaCommand = async (run: () => ReturnType<typeof startCpa>, fallbackMessage: string) => {
    if (!environmentConnected || !canManageCpa || cpaBusy) return;
    setCpaBusy(true);
    setCpaError(null);
    const result = await run().finally(() => setCpaBusy(false));
    if (result._tag === "Success") {
      statusQuery.refresh();
    } else if (!isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setCpaError(failure instanceof Error ? failure.message : fallbackMessage);
    }
  };

  const saveProjectOptimizer = async (id: OptimizerId, enabled: boolean) => {
    if (selectedProjectId === null || savingProject || !environmentConnected) return;
    setSavingProject(true);
    await updateSettings({
      environmentId,
      input: {
        patch: {
          projectOptimizerOverrides: {
            [selectedProjectId]: { [id]: enabled },
          },
        },
      },
    }).finally(() => setSavingProject(false));
  };

  const saveBinaryPath = (next: string) => {
    if (savingBinary || next === cbmBinaryPath || !environmentConnected) return;
    setBinaryDraft(null);
    setSavingBinary(true);
    void updateSettings({
      environmentId,
      input: { patch: { optimizerBinaryPaths: { cbm: next } } },
    }).finally(() => setSavingBinary(false));
  };

  const commitBinaryPath = () => {
    if (binaryDraft === null) return;
    const next = binaryDraft.trim();
    if (next === cbmBinaryPath) {
      setBinaryDraft(null);
      return;
    }
    saveBinaryPath(next);
  };

  const resetBinaryPath = () => {
    saveBinaryPath("");
  };

  return (
    <>
      <SettingsSection
        id="optimizer-status"
        title="Status"
        headerAction={
          <Button
            size="xs"
            variant="outline"
            disabled={statusQuery.isPending || !environmentConnected}
            aria-label="Refresh optimizer status"
            onClick={statusQuery.refresh}
          >
            <RefreshCwIcon className="size-3.5" />
            {statusQuery.isPending ? "Checking…" : "Refresh"}
          </Button>
        }
      >
        {!environmentConnected ? (
          <SettingsRow
            title="Environment not connected"
            description="Reconnect this environment to probe its host-local optimizer tools."
            status={environment?.connection.phase ?? "Unavailable"}
          />
        ) : statusQuery.error ? (
          <SettingsRow
            title="Could not check optimizer status"
            description={statusQuery.error}
            control={
              <Button size="sm" variant="outline" onClick={statusQuery.refresh}>
                Try again
              </Button>
            }
          />
        ) : statusQuery.isPending && statusQuery.data === null ? (
          <SettingsRow
            title="Checking this environment…"
            description="The probe will finish shortly."
          />
        ) : (
          <OptimizerStatusRows
            snapshot={statusQuery.data}
            onStartHeadroom={() => void startHeadroomProxy()}
            canStartHeadroom={canStartHeadroom}
            startingHeadroom={startingHeadroom}
            headroomStartError={headroomStartError}
          />
        )}
      </SettingsSection>

      {environmentConnected && statusQuery.data?.cpa ? (
        <SettingsSection id="optimizer-cpa" title="CLIProxyAPI (CPA)">
          <CpaRows
            cpa={statusQuery.data.cpa}
            canManage={canManageCpa}
            busy={cpaBusy}
            error={cpaError}
            onStart={() =>
              void runCpaCommand(
                () => startCpa({ environmentId, input: {} }),
                "CLIProxyAPI could not be started.",
              )
            }
            onSetRouting={(enabled) =>
              void runCpaCommand(
                () => setCpaRouting({ environmentId, input: { enabled } }),
                "CPA routing could not be changed.",
              )
            }
          />
        </SettingsSection>
      ) : null}

      <SettingsSection id="optimizer-savings" title="Savings">
        <SavingsRows snapshot={statusQuery.data} environmentConnected={environmentConnected} />
      </SettingsSection>

      <SettingsSection id="optimizer-savings-history" title="Savings history">
        <SavingsHistoryRows
          snapshot={statusQuery.data}
          environmentConnected={environmentConnected}
        />
      </SettingsSection>

      <SettingsSection id="optimizer-project" title="Project attachments">
        {environmentProjects.length === 0 ? (
          <SettingsRow
            title="No projects on this environment"
            description="Add a project before choosing optimizer attachments."
          />
        ) : (
          <>
            <SettingsRow
              title="Project"
              description="Optimizer status and attachments below are scoped to this project."
              control={
                <Select
                  value={selectedProjectId ?? ""}
                  onValueChange={(value) => {
                    const project = environmentProjects.find((candidate) => candidate.id === value);
                    setProjectSelection(project?.id ?? null);
                  }}
                >
                  <SelectTrigger
                    size="sm"
                    className="max-w-full sm:w-64"
                    aria-label="Optimizer project"
                  >
                    <SelectValue>{selectedProject?.title ?? "Choose a project"}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    {environmentProjects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        <span className="max-w-80 truncate">{project.title}</span>
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              }
            />
            {OPTIMIZER_ORDER.map((id) => (
              <SettingsRow
                key={id}
                title={OPTIMIZER_META[id].label}
                description={
                  id === "headroom"
                    ? "Routes supported new sessions through the configured Headroom proxy. T3 starts it from Status when requested."
                    : id === "cbm"
                      ? "Starts CBM as a stdio MCP server inside each supported provider session."
                      : "Starts RTK's CLI wrapper inside each supported provider session."
                }
                status={
                  selectedProjectSettings?.[id] === true ? "Enabled for the next session" : "Off"
                }
                control={
                  <Switch
                    checked={selectedProjectSettings?.[id] === true}
                    disabled={savingProject || selectedProjectId === null || !environmentConnected}
                    aria-label={`Enable ${OPTIMIZER_META[id].label} for project`}
                    onCheckedChange={(enabled) => void saveProjectOptimizer(id, enabled)}
                  />
                }
              />
            ))}
            <CbmIndexRow projectId={selectedProjectId} snapshot={statusQuery.data} />
          </>
        )}
      </SettingsSection>

      <SettingsSection id="optimizer-compatibility" title="Provider compatibility">
        {OPTIMIZER_ORDER.map((id) => (
          <ProviderCompatibilityRow key={id} id={id} />
        ))}
      </SettingsSection>

      <SettingsSection id="optimizer-configuration" title="Configuration">
        <HeadroomProxySettingsRow
          key={environmentId}
          environmentId={environmentId}
          environmentConnected={environmentConnected}
          proxyUrl={settings.headroomProxyUrl}
          onSaved={statusQuery.refresh}
        />
        <SettingsRow
          title="CBM binary path"
          description="Use a custom codebase-memory-mcp executable when it is not on PATH. Leave blank to use codebase-memory-mcp."
          resetAction={
            cbmBinaryPath !== "codebase-memory-mcp" ? (
              <SettingResetButton
                label="CBM binary path"
                disabled={savingBinary || !environmentConnected}
                onClick={resetBinaryPath}
              />
            ) : null
          }
          control={
            <Input
              size="sm"
              className="w-full sm:w-64"
              value={binaryDraft ?? cbmBinaryPath}
              disabled={savingBinary || !environmentConnected}
              aria-label="CBM binary path"
              onChange={(event) => setBinaryDraft(event.currentTarget.value)}
              onBlur={commitBinaryPath}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
          }
        />
      </SettingsSection>
    </>
  );
}
export function OptimizersSettingsPanel() {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const [environmentSelection, setEnvironmentSelection] = useState<EnvironmentId | null>(
    primaryEnvironmentId ?? environments[0]?.environmentId ?? null,
  );

  const selectedEnvironmentId =
    environmentSelection !== null &&
    environments.some((environment) => environment.environmentId === environmentSelection)
      ? environmentSelection
      : (primaryEnvironmentId ?? environments[0]?.environmentId ?? null);

  const selectedEnvironment = environments.find(
    (environment) => environment.environmentId === selectedEnvironmentId,
  );

  return (
    <SettingsPageContainer width="wide">
      <SettingsSection id="optimizers" title="Optimizers">
        <SettingsRow
          title="Environment"
          description="Status, savings, and project attachments below belong to this environment."
          control={
            environments.length > 0 ? (
              <Select
                value={selectedEnvironmentId ?? ""}
                onValueChange={(value) => {
                  const environment = environments.find(
                    (candidate) => candidate.environmentId === value,
                  );
                  setEnvironmentSelection(environment?.environmentId ?? null);
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="max-w-full sm:w-64"
                  aria-label="Optimizer environment"
                >
                  <SelectValue>{selectedEnvironment?.label ?? "Choose an environment"}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {environments.map((environment) => (
                    <SelectItem key={environment.environmentId} value={environment.environmentId}>
                      <span className="flex max-w-80 items-center gap-2">
                        <span className="truncate">{environment.label}</span>
                        {environment.connection.phase !== "connected" ? (
                          <span className="text-xs text-muted-foreground">
                            {environment.connection.phase}
                          </span>
                        ) : null}
                      </span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : (
              <span className="text-sm text-muted-foreground">No environments connected</span>
            )
          }
        />
      </SettingsSection>
      {selectedEnvironmentId === null ? (
        <SettingsSection id="optimizer-empty" title="Optimizer status">
          <SettingsRow
            title="Connect an environment"
            description="Optimizer status lives on a T3 server. Connect an environment to inspect its host-local tools."
          />
        </SettingsSection>
      ) : (
        <OptimizerEnvironmentSettings environmentId={selectedEnvironmentId} />
      )}
    </SettingsPageContainer>
  );
}
