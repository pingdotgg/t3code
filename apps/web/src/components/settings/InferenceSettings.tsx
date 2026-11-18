import {
  inferenceRouteIssue,
  type InferenceRouting,
  type InferenceProxyActionResult,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  inferenceHostCandidates,
  inferenceHostRoutingIssue,
} from "@t3tools/client-runtime/state/inference-proxy";
import {
  INFERENCE_DRIVERS,
  INFERENCE_HARNESSES,
  type EnvironmentId,
  type InferenceDriver,
  type InferenceProxyAction,
} from "@t3tools/contracts";
import { useState } from "react";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsSection, SettingsRow } from "./settingsLayout";
import { InferenceProviderAccounts } from "./InferenceProviderAccounts";

const { inferenceProxy } = serverEnvironment;

function InferenceRoute({
  host,
  consumer,
}: {
  host: EnvironmentPresentation;
  consumer: EnvironmentPresentation;
}) {
  const canGrant = useAtomValue(inferenceProxy.canGrant(host.environmentId));
  const canConnect = useAtomValue(inferenceProxy.canConnect(consumer.environmentId));
  const status = useEnvironmentQuery(
    inferenceProxy.inferenceStatus({ environmentId: host.environmentId, input: {} }),
  );
  const issue = inferenceRouteIssue(status.data, host.environmentId === consumer.environmentId);
  const route = useAtomCommand(inferenceProxy.routeInference, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  async function add(driver: InferenceDriver) {
    setBusy(true);
    setNotice("");
    const result = await route({ host, consumer, driver });
    setBusy(false);
    setNotice(
      result._tag === "Failure"
        ? String(squashAtomCommandFailure(result))
        : `Select ${INFERENCE_HARNESSES[driver].label}${host.environmentId === consumer.environmentId ? "" : ` via ${host.label}`} in the model picker.`,
    );
  }
  return (
    <SettingsRow
      title={host.label}
      description={
        issue ??
        (host.environmentId === consumer.environmentId
          ? "Use accounts on this environment."
          : "Use this host’s accounts over Tailscale or your trusted LAN.")
      }
      status={notice || undefined}
      control={
        <div className="flex gap-2">
          {INFERENCE_DRIVERS.map((driver) => (
            <Button
              key={driver}
              size="sm"
              variant="outline"
              disabled={
                !canGrant ||
                !canConnect ||
                busy ||
                inferenceHostRoutingIssue(status.data, { host, consumer, driver }) !== null
              }
              onClick={() => void add(driver)}
            >
              {INFERENCE_HARNESSES[driver].label}
            </Button>
          ))}
        </div>
      }
    />
  );
}

function InferenceRoutingControls({
  routing,
  disabled,
  run,
}: {
  routing: InferenceRouting;
  disabled: boolean;
  run: (action: InferenceProxyAction) => Promise<InferenceProxyActionResult | undefined>;
}) {
  return (
    <SettingsSection title="Account routing">
      <SettingsRow
        title="Round-robin routing"
        description="Distribute requests across eligible credentials. Turn off to use the first available credential."
        control={
          <Switch
            aria-label="Round-robin routing"
            checked={routing.strategy === "round-robin"}
            disabled={disabled}
            onCheckedChange={(enabled) =>
              void run({
                operation: "setRouting",
                strategy: enabled ? "round-robin" : "fill-first",
              })
            }
          />
        }
      />
      <SettingsRow
        title="Keep sessions on one account"
        description="Reuse the same credential for a conversation while it is available."
        control={
          <Switch
            aria-label="Keep sessions on one account"
            checked={routing.sessionAffinity}
            disabled={disabled}
            onCheckedChange={(sessionAffinity) =>
              void run({ operation: "setRouting", sessionAffinity })
            }
          />
        }
      />
    </SettingsSection>
  );
}

export function InferenceSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const { environments } = useEnvironments();
  const current = environments.find((e) => e.environmentId === environmentId);
  const canManage = useAtomValue(inferenceProxy.manageInference.permissionAtom(environmentId));
  const query = useEnvironmentQuery(
    canManage ? inferenceProxy.inferenceStatus({ environmentId, input: {} }) : null,
  );
  const command = useAtomCommand(inferenceProxy.manageInference, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const host = query.data;
  const updateQuery = useEnvironmentQuery(
    host?.enabled
      ? inferenceProxy.updates({ environmentId, input: { operation: "checkUpdate" } })
      : null,
  );
  const available = updateQuery.data?.update?.available;
  async function run(input: InferenceProxyAction) {
    setBusy(true);
    setNotice("");
    const result = await command({ environmentId, input });
    setBusy(false);
    if (result._tag === "Failure") {
      setNotice(String(squashAtomCommandFailure(result)));
      return;
    }
    return result.value;
  }
  return (
    <SettingsPageContainer className="gap-8">
      <SettingsSection id="inference" title="Inference hosting">
        {!canManage ? (
          <SettingsRow title="Provider management access is required." />
        ) : host ? (
          <>
            <SettingsRow
              title="Host accounts on this environment"
              description={`T3 Code installs CLIProxyAPI ${host.version} and keeps account logins here.`}
              status={busy ? "Working…" : (host.problem ?? (host.running ? "Running" : "Stopped"))}
              control={
                <Switch
                  aria-label="Host inference accounts"
                  checked={host.enabled}
                  disabled={busy}
                  onCheckedChange={(enabled) =>
                    void run({
                      operation: "configure",
                      enabled,
                      sharing: false,
                      expectedEnabled: host.enabled,
                    })
                  }
                />
              }
            />
            {host.enabled && (
              <>
                <SettingsRow
                  title="CLIProxyAPI updates"
                  description={
                    updateQuery.error ??
                    (available
                      ? `Version ${available} is available. Updating restarts the inference host.`
                      : `Installed version: ${host.version}`)
                  }
                  control={
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || updateQuery.isPending}
                      onClick={() =>
                        available ? void run({ operation: "update" }) : updateQuery.refresh()
                      }
                    >
                      {available ? "Update" : "Check for updates"}
                    </Button>
                  }
                />
                <SettingsRow
                  title="Share inference with paired environments"
                  description="Use Tailscale HTTPS or enable LAN access on a trusted network. LAN HTTP sends requests and route keys unencrypted. Turning sharing off revokes remote access."
                  control={
                    <Switch
                      aria-label="Share inference with paired environments"
                      checked={host.sharing}
                      disabled={busy}
                      onCheckedChange={(sharing) =>
                        void run({
                          operation: "configure",
                          enabled: true,
                          sharing,
                          expectedEnabled: true,
                        })
                      }
                    />
                  }
                />
                {host.consumers.map((c) => (
                  <SettingsRow
                    key={c.environmentId}
                    title={c.label}
                    description="Authorized for inference"
                    control={
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void run({ operation: "revoke", environmentId: c.environmentId })
                        }
                      >
                        Revoke
                      </Button>
                    }
                  />
                ))}
              </>
            )}
          </>
        ) : (
          <SettingsRow title={query.error ?? "Loading host status…"} />
        )}
      </SettingsSection>
      {host?.enabled && (
        <SettingsSection title="Hosted accounts">
          <InferenceProviderAccounts environmentId={environmentId} />
        </SettingsSection>
      )}
      {host?.enabled && host.routing && (
        <InferenceRoutingControls routing={host.routing} disabled={busy || !canManage} run={run} />
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      {current && canManage && (
        <SettingsSection title="Route requests through an environment">
          <SettingsRow
            title={`Run agents on ${current.label}`}
            description="Choose a host and provider below. Tools and files stay on this environment. Choosing a host changes where this provider sends inference. That host manages the accounts."
          />
          {host?.routes.map((route) => (
            <SettingsRow
              key={route.instanceId}
              title={route.label}
              description="Using an inference host on this environment"
              control={
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void run({ operation: "removeRoute", instanceId: route.instanceId })
                  }
                >
                  Use native provider
                </Button>
              }
            />
          ))}
          {inferenceHostCandidates(environments, environmentId).map((e) => (
            <InferenceRoute key={e.environmentId} host={e} consumer={current} />
          ))}
        </SettingsSection>
      )}
    </SettingsPageContainer>
  );
}
