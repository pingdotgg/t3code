import {
  orbitConnectionChecks,
  orbitNodeServers,
  orbitSignedInText,
  renewalFailureText,
  type EnvironmentProvider,
  type OrbitConnectionCheckState,
  type OrbitConnectionProbe,
  type OrbitGatewayEnvironment,
  type OrbitNodeState,
  visibleOrbitEnvironments,
} from "@t3tools/client-runtime/orbit-gateway";
import { useNavigate } from "@tanstack/react-router";
import { CheckIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  connectOrbitEnvironment,
  retryOrbitRenewal,
  setEnvironmentProvider,
  useEnvironmentProvider,
} from "~/orbit/environmentProvider";
import { desktopOrbitGatewayClient } from "~/orbit/OrbitProfileSync";
import { useEnvironments } from "~/state/environments";

import { cn } from "~/lib/utils";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting, SETTINGS_SECTION_LABELS } from "./settingsSearch";
import { useMessages } from "gt-react";
import { useStableCallback } from "~/hooks/useStableCallback";

const PROVIDER_LABELS: Record<EnvironmentProvider, string> = {
  default: "Default",
  orbit: "Orbit",
};

/**
 * Where this device's environments come from: the ones added here (Default) or the T3 servers on
 * the Orbit Gateway (Orbit). Only the desktop app can reach the Gateway, so a browser never offers
 * Orbit.
 */
export function EnvironmentProviderSection() {
  const provider = useEnvironmentProvider((state) => state.provider);
  const orbitAvailable = !!window.desktopBridge?.orbitGatewaySend;
  if (!orbitAvailable && provider === "default") return null;

  return (
    <SettingsSection {...searchableSetting("environment-provider")}>
      <SettingsRow
        title="Environments from"
        description={
          provider === "orbit"
            ? "The T3 servers registered on the Orbit Gateway. Host servers pair automatically. Instances are managed in the Orbit panel. Environments added here are switched off until you choose Default again."
            : "Environments you add on this device. Orbit uses the servers on the Orbit Gateway instead and syncs workspaces with your profile."
        }
        control={
          <Select
            value={provider}
            onValueChange={(next) => {
              if (next === "default" || next === "orbit") setEnvironmentProvider(next);
            }}
          >
            <SelectTrigger size="sm" aria-label="Environments from">
              <SelectValue>{PROVIDER_LABELS[provider]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value="default">{PROVIDER_LABELS.default}</SelectItem>
              {orbitAvailable ? (
                <SelectItem value="orbit">{PROVIDER_LABELS.orbit}</SelectItem>
              ) : null}
            </SelectPopup>
          </Select>
        }
      />
    </SettingsSection>
  );
}

const CHECK_BADGES: Record<
  OrbitConnectionCheckState,
  { readonly label: string; readonly variant: "success" | "error" | "outline" }
> = {
  pass: { label: "OK", variant: "success" },
  fail: { label: "Failed", variant: "error" },
  checking: { label: "Checking", variant: "outline" },
  not_checked: { label: "Not checked", variant: "outline" },
};

function CheckBadge({ state }: { readonly state: OrbitConnectionCheckState }) {
  const { label, variant } = CHECK_BADGES[state];
  return (
    <Badge variant={variant} data-check-state={state}>
      {state === "pass" ? (
        <CheckIcon />
      ) : state === "fail" ? (
        <XIcon />
      ) : state === "checking" ? (
        <Spinner />
      ) : null}
      {label}
    </Badge>
  );
}

const NODE_STATES: Record<OrbitNodeState, { readonly label: string; readonly dot: string }> = {
  paired: { label: "Paired", dot: "bg-success" },
  pairing: { label: "Pairing…", dot: "bg-muted-foreground/40" },
  expired: { label: "Registration expired", dot: "bg-warning" },
  revoked: { label: "Revoked in Orbit", dot: "bg-destructive" },
  // The row shows the reason's sentence (renewalFailureText) in place of this label.
  renewal_failed: { label: "Could not renew.", dot: "bg-warning" },
};

/**
 * The Gateway's answer to `me` (which runs the three checks) and its server list. Reload runs both
 * again; an answer to an earlier load that comes late is dropped.
 */
function useOrbitConnection() {
  // One client per mount: the load effect below must not restart on every render.
  const [client] = useState(desktopOrbitGatewayClient);
  // Without a client (outside the desktop app) nothing runs, so the checks settle as not checked.
  const [probe, setProbe] = useState<OrbitConnectionProbe>(() =>
    client ? { status: "checking" } : { status: "unavailable" },
  );
  const [environments, setEnvironments] = useState<readonly OrbitGatewayEnvironment[] | null>(null);
  const latest = useRef(0);

  const load = useStableCallback(async () => {
    if (!client) return;
    const run = ++latest.current;
    setProbe({ status: "checking" });
    const [me, servers] = await Promise.allSettled([client.me(), client.environments()]);
    if (run !== latest.current) return;
    setProbe(
      me.status === "fulfilled"
        ? { status: "ok", node: me.value }
        : { status: "error", error: me.reason },
    );
    setEnvironments(
      servers.status === "fulfilled" ? visibleOrbitEnvironments(servers.value) : null,
    );
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the Orbit Gateway once on mount; Reload reads it again
  useEffect(() => {
    void load();
  }, [load]);

  return { probe, environments, load };
}

/** Conn: Retry for a server whose last renewal failed: renews it now, without the planner's wait. */
function RenewalRetryButton(props: {
  readonly environmentId: string;
  readonly environments: readonly OrbitGatewayEnvironment[] | null;
}) {
  const [renewing, setRenewing] = useState(false);
  const environment = props.environments?.find(
    (entry) => entry.environmentId === props.environmentId,
  );
  if (!environment) return null;
  return (
    <Button
      size="xs"
      variant="outline"
      disabled={renewing}
      onClick={() => {
        const client = desktopOrbitGatewayClient();
        if (!client) return;
        setRenewing(true);
        void retryOrbitRenewal(client, environment).finally(() => setRenewing(false));
      }}
    >
      {renewing ? "Renewing…" : "Retry"}
    </Button>
  );
}

/**
 * Conn: Connect for a server whose pairing Orbit revoked; the one way to pair it again. It lifts
 * the revoked state first, so renewals resume even when this pairing fails.
 */
function RevokedConnectButton(props: {
  readonly environmentId: string;
  readonly environments: readonly OrbitGatewayEnvironment[] | null;
}) {
  const [connecting, setConnecting] = useState(false);
  const environment = props.environments?.find(
    (entry) => entry.environmentId === props.environmentId,
  );
  if (!environment) return null;
  return (
    <Button
      size="xs"
      variant="outline"
      disabled={connecting}
      onClick={() => {
        const client = desktopOrbitGatewayClient();
        if (!client) return;
        setConnecting(true);
        void connectOrbitEnvironment(client, environment).finally(() => setConnecting(false));
      }}
    >
      {connecting ? "Connecting…" : "Connect"}
    </Button>
  );
}

/**
 * The Orbit panel's Connection page: this device's Node, the three checks of its connection to
 * the Gateway, and the Nodes that run a T3 server. Conn picks up the connection from the machine,
 * so a failed check says what to fix outside Conn. Instances are on the Instances page.
 */
export function OrbitConnectionPage() {
  const { probe, environments, load } = useOrbitConnection();
  const { environments: savedEnvironments } = useEnvironments();
  const revokedAt = useEnvironmentProvider((store) => store.state.revokedAt);
  const renewalFailed = useEnvironmentProvider((store) => store.state.renewalFailed);
  const navigate = useNavigate();
  const m = useMessages();
  const connectionsLabel = m(SETTINGS_SECTION_LABELS["/settings/connections"]);

  const node = probe.status === "ok" ? probe.node : null;
  const checks = orbitConnectionChecks(probe);
  const nodes =
    environments === null
      ? null
      : orbitNodeServers({
          environments,
          paired: new Set(
            savedEnvironments.map((environment) => String(environment.environmentId)),
          ),
          revoked: new Set(Object.keys(revokedAt ?? {})),
          renewalFailed: new Map(
            Object.entries(renewalFailed ?? {}).map(([id, failure]) => [id, failure.reason]),
          ),
          device: node,
        });

  return (
    <SettingsPageContainer width="wide">
      <SettingsSection id="orbit-device" title="This device" hideTitle>
        <SettingsRow
          title={node?.name ?? "This device"}
          description={
            node
              ? orbitSignedInText(node)
              : probe.status === "checking"
                ? "Connecting to gateway.orbit…"
                : "The Node name and WireGuard address show once all checks pass."
          }
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={probe.status === "checking" || probe.status === "unavailable"}
              onClick={() => void load()}
            >
              Reload
            </Button>
          }
        />
      </SettingsSection>

      <SettingsSection id="orbit-checks" title="Connection checks" hideTitle>
        {checks.map((check) => (
          <SettingsRow
            key={check.key}
            data-check={check.key}
            title={check.label}
            description={check.message}
            control={<CheckBadge state={check.state} />}
          />
        ))}
      </SettingsSection>

      <section id="orbit-nodes" className="space-y-2.5">
        <div className="px-3 sm:px-4">
          <h2 className="flex min-h-7 items-center text-base font-semibold text-foreground">
            Nodes
          </h2>
          <p className="text-xs text-muted-foreground">
            The Nodes that run a T3 server. Conn pairs with them automatically.
          </p>
        </div>
        <SettingsSection title="Nodes that run a T3 server" hideTitle>
          {nodes === null ? (
            <SettingsRow
              title={probe.status === "checking" ? "Loading…" : "Nodes not available"}
              description={
                probe.status === "checking"
                  ? "Reading the Nodes from gateway.orbit."
                  : probe.status === "unavailable"
                    ? undefined
                    : probe.status === "ok"
                      ? "The Gateway did not send its list of servers. Reload to try again."
                      : "The Nodes show once the Gateway answers. Reload to try again."
              }
            />
          ) : nodes.length === 0 ? (
            <SettingsRow
              title="No Nodes yet"
              description="A Node's T3 server registers itself with the Gateway."
            />
          ) : (
            nodes.map((entry) => (
              <SettingsRow
                key={entry.environmentId}
                title={
                  <span className="flex items-center gap-2">
                    <span
                      aria-hidden
                      className={cn("size-2 shrink-0 rounded-full", NODE_STATES[entry.state].dot)}
                    />
                    {entry.name}
                  </span>
                }
                description={entry.isThisDevice ? `This device · ${entry.address}` : entry.address}
                control={
                  <span className="flex items-center gap-3">
                    <span className="text-ui text-muted-foreground">
                      {entry.renewalFailure !== null
                        ? renewalFailureText(entry.renewalFailure)
                        : NODE_STATES[entry.state].label}
                    </span>
                    {entry.state === "revoked" ? (
                      <RevokedConnectButton
                        environmentId={entry.environmentId}
                        environments={environments}
                      />
                    ) : entry.state === "renewal_failed" ? (
                      <RenewalRetryButton
                        environmentId={entry.environmentId}
                        environments={environments}
                      />
                    ) : null}
                  </span>
                }
              />
            ))
          )}
        </SettingsSection>
      </section>

      <SettingsSection id="orbit-environments-from" title="Environments from Orbit" hideTitle>
        <SettingsRow
          title="Environments from Orbit"
          description={`Orbit is turned on and off in Settings > ${connectionsLabel}, with "Environments from". While it is off, the Orbit icon is hidden.`}
          control={
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                void navigate({ to: "/settings/connections", hash: "environment-provider" })
              }
            >
              Open {connectionsLabel}
            </Button>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
