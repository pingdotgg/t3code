import type { CpaStatus, EnvironmentId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { CheckCircle2Icon, CircleAlertIcon, ExternalLinkIcon } from "lucide-react";
import { useState } from "react";

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { OptimizerEnvironmentRow, useOptimizerEnvironmentSelection } from "./OptimizersSettings";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

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

function CpaEnvironmentSettings({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const environment = useEnvironments().environments.find(
    (candidate) => candidate.environmentId === environmentId,
  );
  const statusQuery = useEnvironmentQuery(
    environment?.connection.phase === "connected"
      ? serverEnvironment.optimizersGetStatus({
          environmentId,
          input: { refresh: true },
        })
      : null,
  );
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

  if (!environmentConnected) {
    return (
      <SettingsSection id="cpa-status" title="CLIProxyAPI (CPA)">
        <SettingsRow
          title="Environment not connected"
          description="Reconnect this environment to check its CLIProxyAPI."
          status={environment?.connection.phase ?? "Unavailable"}
        />
      </SettingsSection>
    );
  }

  if (!statusQuery.data?.cpa) {
    return (
      <SettingsSection id="cpa-status" title="CLIProxyAPI (CPA)">
        <SettingsRow
          title={
            statusQuery.error
              ? "Could not check CLIProxyAPI"
              : statusQuery.isPending
                ? "Checking this environment…"
                : "CLIProxyAPI is not available"
          }
          description={statusQuery.error ?? "This environment does not report a CLIProxyAPI proxy."}
        />
      </SettingsSection>
    );
  }

  return (
    <SettingsSection id="cpa-status" title="CLIProxyAPI (CPA)">
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
  );
}

export function CliProxySettingsPanel() {
  const selection = useOptimizerEnvironmentSelection();

  return (
    <SettingsPageContainer width="wide">
      <SettingsSection id="cpa" title="CLIProxyAPI">
        <OptimizerEnvironmentRow
          description="The CLIProxyAPI status and routing below belong to this environment."
          ariaLabel="CLIProxyAPI environment"
          selection={selection}
        />
      </SettingsSection>
      {selection.selectedEnvironmentId === null ? null : (
        <CpaEnvironmentSettings environmentId={selection.selectedEnvironmentId} />
      )}
    </SettingsPageContainer>
  );
}
