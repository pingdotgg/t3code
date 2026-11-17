import {
  inferenceRouteIssue,
  type InferenceRouting,
  type InferenceProxyActionResult,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  inferenceAccountRetryAfter,
  inferenceAccountStatus,
} from "@t3tools/client-runtime/state/inference-proxy";
import {
  INFERENCE_DRIVERS,
  INFERENCE_HARNESSES,
  INFERENCE_UPSTREAMS,
  inferenceHarness,
  type InferenceDriver,
  type InferenceProxyAction,
  type InferenceUpstream,
} from "@t3tools/contracts";
import { useState } from "react";
import { Linking, TextInput, View } from "react-native";

import { AppText } from "../../components/ui/AppText";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import type { SettingsTarget } from "./settings-environment-filter";

const upstreams = Object.keys(INFERENCE_UPSTREAMS) as ReadonlyArray<InferenceUpstream>;
const { inferenceProxy } = serverEnvironment;

function Route({ host, consumer }: { host: EnvironmentPresentation; consumer: SettingsTarget }) {
  const grant = useAtomValue(inferenceProxy.canGrant(host.environmentId));
  const connect = useAtomValue(inferenceProxy.canConnect(consumer.environmentId));
  const status = useEnvironmentQuery(
    inferenceProxy.inferenceStatus({ environmentId: host.environmentId, input: {} }),
  );
  const issue = inferenceRouteIssue(status.data, host.environmentId === consumer.environmentId);
  const route = useAtomCommand(inferenceProxy.routeInference, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  async function add(driver: InferenceDriver) {
    setBusy(true);
    const result = await route({ host, consumer, driver });
    setBusy(false);
    setNotice(
      result._tag === "Success"
        ? `Select ${INFERENCE_HARNESSES[driver].label}${host.environmentId === consumer.environmentId ? "" : ` via ${host.label}`} in the model picker.`
        : String(squashAtomCommandFailure(result)),
    );
  }
  return (
    <View>
      {INFERENCE_DRIVERS.map((driver) => (
        <ListActionRow
          key={driver}
          label={`Route ${INFERENCE_HARNESSES[driver].label} through ${host.label}`}
          description={issue ?? undefined}
          disabled={busy || !grant || !connect || !!issue}
          onPress={() => void add(driver)}
        />
      ))}
      {notice ? (
        <AppText accessibilityLiveRegion="polite" className="px-4 text-foreground">
          {notice}
        </AppText>
      ) : null}
    </View>
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
    <View className="gap-3">
      <SettingsSwitchRow
        label="Round-robin routing"
        subtitle="Distribute requests across eligible credentials. Turn off to use the first available credential."
        value={routing.strategy === "round-robin"}
        disabled={disabled}
        onValueChange={(enabled) =>
          void run({ operation: "setRouting", strategy: enabled ? "round-robin" : "fill-first" })
        }
      />
      <SettingsSwitchRow
        label="Keep sessions on one account"
        subtitle="Reuse the same credential for a conversation while it is available."
        value={routing.sessionAffinity}
        disabled={disabled}
        onValueChange={(sessionAffinity) => void run({ operation: "setRouting", sessionAffinity })}
      />
    </View>
  );
}

function InferenceControls({ environment }: { environment: SettingsTarget }) {
  const { environmentId } = environment;
  const { environments } = useEnvironments();
  const query = useEnvironmentQuery(inferenceProxy.inferenceStatus({ environmentId, input: {} }));
  const command = useAtomCommand(inferenceProxy.manageInference, { reportFailure: false });
  const permitted = useAtomValue(inferenceProxy.manageInference.permissionAtom(environmentId));
  const [pending, setPending] = useState(false);
  const [login, setLogin] = useState<{ url: string; state: string } | null>(null);
  const [callback, setCallback] = useState("");
  const [notice, setNotice] = useState("");
  async function run(input: InferenceProxyAction) {
    setPending(true);
    setNotice("");
    const result = await command({ environmentId, input });
    setPending(false);
    if (result._tag === "Failure") {
      setNotice(String(squashAtomCommandFailure(result)));
      return;
    }
    if (result.value.login) {
      setLogin(result.value.login);
      setCallback("");
    }
    if (
      input.operation === "cancel" ||
      (input.operation === "configure" && !input.enabled) ||
      result.value.status === "ok" ||
      result.value.status === "error"
    ) {
      setLogin(null);
      setCallback("");
    }
    if (result.value.status === "error")
      setNotice("Sign-in failed or expired. Start a new sign-in.");
    if (result.value.status === "wait")
      setNotice("Waiting for the host to finish sign-in. Check status after a moment.");
    return result.value;
  }
  const host = query.data;
  const updateQuery = useEnvironmentQuery(
    host?.enabled
      ? inferenceProxy.updates({ environmentId, input: { operation: "checkUpdate" } })
      : null,
  );
  const available = updateQuery.data?.update?.available;
  const disabled = pending || !permitted;
  return (
    <View className="gap-1">
      {host ? (
        <>
          <SettingsSwitchRow
            label="Host accounts here"
            subtitle={
              host.problem ??
              (host.running
                ? `CLIProxyAPI ${host.version} is running.`
                : `Enable to install and start CLIProxyAPI ${host.version}.`)
            }
            disabled={disabled}
            value={host.enabled}
            onValueChange={(enabled) =>
              void run({ operation: "configure", enabled, sharing: false })
            }
          />
          {host.enabled && (
            <>
              <ListActionRow
                label={
                  available ? `Update CLIProxyAPI to ${available}` : "Check for CLIProxyAPI updates"
                }
                description={
                  updateQuery.error ??
                  (available
                    ? "Restarts the inference host."
                    : `Installed version: ${host.version}`)
                }
                disabled={disabled || updateQuery.isPending}
                onPress={() =>
                  available ? void run({ operation: "update" }) : updateQuery.refresh()
                }
              />
              <SettingsSwitchRow
                label="Share inference with paired environments"
                subtitle="Use Tailscale HTTPS or a trusted LAN. LAN HTTP sends requests and route keys unencrypted. Turning sharing off revokes remote access."
                disabled={disabled}
                value={host.sharing}
                onValueChange={(sharing) =>
                  void run({ operation: "configure", enabled: true, sharing })
                }
              />
              {host.routing && (
                <InferenceRoutingControls routing={host.routing} disabled={disabled} run={run} />
              )}
              {host.consumers.map((c) => (
                <ListActionRow
                  key={c.environmentId}
                  label={`Revoke access for ${c.label}`}
                  disabled={disabled}
                  onPress={() => void run({ operation: "revoke", environmentId: c.environmentId })}
                />
              ))}
              {host.accounts.map((account) => {
                const retryAfter = inferenceAccountRetryAfter(account);
                return (
                  <ListActionRow
                    key={account.name}
                    label={`Remove ${account.name}`}
                    description={`${account.provider} · ${inferenceAccountStatus(account)}${retryAfter ? ` · Retry after ${new Date(retryAfter).toLocaleString()}` : ""}`}
                    disabled={disabled}
                    onPress={() => void run({ operation: "removeAccount", name: account.name })}
                  />
                );
              })}
              {login ? (
                <>
                  <ListActionRow
                    label="Open sign-in page"
                    description="Paste the final localhost URL below, even if your browser cannot load it."
                    onPress={() =>
                      void Linking.openURL(login.url).catch(() =>
                        setNotice("Could not open sign-in page."),
                      )
                    }
                  />
                  <TextInput
                    accessibilityLabel="Sign-in callback URL"
                    placeholder="Paste callback URL"
                    secureTextEntry
                    autoCapitalize="none"
                    autoCorrect={false}
                    editable={!disabled}
                    value={callback}
                    onChangeText={setCallback}
                    className="mx-4 rounded-lg border border-border-subtle px-3 py-2 text-foreground"
                  />
                  <ListActionRow
                    label="Submit callback"
                    disabled={disabled || !callback}
                    onPress={() =>
                      void run({ operation: "callback", state: login.state, callback })
                    }
                  />
                  <ListActionRow
                    label="Check sign-in status"
                    disabled={disabled}
                    onPress={() => void run({ operation: "check", state: login.state })}
                  />
                  <ListActionRow
                    label="Cancel sign-in"
                    disabled={disabled}
                    onPress={() => void run({ operation: "cancel", state: login.state })}
                  />
                </>
              ) : (
                upstreams.map((upstream) => (
                  <ListActionRow
                    key={upstream}
                    label={`Add ${INFERENCE_UPSTREAMS[upstream]} account`}
                    disabled={disabled}
                    onPress={() => void run({ operation: "signIn", upstream })}
                  />
                ))
              )}
            </>
          )}
        </>
      ) : (
        <AppText className="px-4 text-foreground-muted">
          {query.error ?? "Loading host status…"}
        </AppText>
      )}
      {notice ? (
        <AppText accessibilityLiveRegion="polite" className="px-4 text-foreground">
          {notice}
        </AppText>
      ) : null}
      <AppText className="px-4 text-foreground-muted">
        Choose a host for inference. Tools run on {environment.label}. Choosing a host changes where
        this provider sends inference. That host manages the accounts.
      </AppText>
      {host?.routes.map((route) => (
        <ListActionRow
          key={route.instanceId}
          label={`Use native ${inferenceHarness(route.instanceId)?.label ?? route.instanceId}`}
          description={`Now: ${route.label}`}
          disabled={disabled}
          onPress={() => void run({ operation: "removeRoute", instanceId: route.instanceId })}
        />
      ))}
      {environments
        .filter(
          (e) =>
            e.connection.phase === "connected" &&
            e.serverConfig?.environment.capabilities.inferenceProxy,
        )
        .map((host) => (
          <Route key={host.environmentId} host={host} consumer={environment} />
        ))}
    </View>
  );
}

export function InferenceAccounts({ environment }: { environment: SettingsTarget }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <ListActionRow
        label="Inference accounts"
        description={
          open ? "Hide hosts and routes" : "Host accounts or route requests through an environment"
        }
        onPress={() => setOpen((value) => !value)}
      />
      {open && <InferenceControls environment={environment} />}
    </>
  );
}
