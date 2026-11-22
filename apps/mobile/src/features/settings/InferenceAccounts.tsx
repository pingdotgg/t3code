import { T, Var, useGT, useMessages } from "gt-react-native";
import { type InferenceRouting, type InferenceProxyActionResult } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  inferenceAccountRetryAfter,
  inferenceAccountStatus,
  inferenceHostCandidates,
  inferenceHostRoutingIssue,
} from "@t3tools/client-runtime/state/inference-proxy";
import {
  INFERENCE_DRIVERS,
  INFERENCE_HARNESSES,
  INFERENCE_UPSTREAMS,
  defaultInstanceIdForDriver,
  inferenceHarness,
  isCustomInferenceBackend,
  isInferenceProviderConfig,
  isInferenceRoutingEnabled,
  isManagedSettingPath,
  ProviderDriverKind,
  type InferenceProxyStatus,
  type ServerProvider,
  type InferenceDriver,
  type InferenceProxyAction,
  type InferenceUpstream,
} from "@t3tools/contracts";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Linking, TextInput, View } from "react-native";

import { AppText } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import type { SettingsTarget } from "./settings-environment-filter";
import { m } from "../../i18n/messages";

const upstreams = Object.keys(INFERENCE_UPSTREAMS) as ReadonlyArray<InferenceUpstream>;
const { inferenceProxy } = serverEnvironment;

function Route({ host, consumer }: { host: EnvironmentPresentation; consumer: SettingsTarget }) {
  const gt = useGT();
  const messages = useMessages();
  const grant = useAtomValue(inferenceProxy.canGrant(host.environmentId));
  const connect = useAtomValue(inferenceProxy.canConnect(consumer.environmentId));
  const status = useEnvironmentQuery(
    inferenceProxy.inferenceStatus({ environmentId: host.environmentId, input: {} }),
  );
  const route = useAtomCommand(inferenceProxy.routeInference, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<ReactNode>("");
  async function add(driver: InferenceDriver) {
    setBusy(true);
    const result = await route({ host, consumer, driver });
    setBusy(false);
    setNotice(
      result._tag === "Success" ? (
        <T>
          <Var>{INFERENCE_HARNESSES[driver].label}</Var> now uses accounts on{" "}
          <Var>{host.label}</Var>.
        </T>
      ) : (
        String(squashAtomCommandFailure(result))
      ),
    );
  }
  return (
    <View>
      {INFERENCE_DRIVERS.map((driver) => {
        const issue = inferenceHostRoutingIssue(status.data, { host, consumer, driver }, messages);
        return (
          <ListActionRow
            key={driver}
            label={gt("Route {provider} through {host}", {
              provider: INFERENCE_HARNESSES[driver].label,
              host: host.label,
            })}
            description={issue ?? undefined}
            disabled={busy || !grant || !connect || !!issue}
            onPress={() => void add(driver)}
          />
        );
      })}
      {notice ? (
        <AppText accessibilityLiveRegion="polite" className="px-4 text-foreground">
          {notice}
        </AppText>
      ) : null}
    </View>
  );
}

function ProviderRoutingSwitch({
  environment,
  provider,
  driver,
  onSetup,
  onRouteChange,
}: {
  environment: SettingsTarget;
  provider: ServerProvider;
  driver: InferenceDriver;
  onSetup: () => void;
  onRouteChange: () => void;
}) {
  const gt = useGT();
  const { environmentId } = environment;
  const { environments } = useEnvironments();
  const canConnect = useAtomValue(inferenceProxy.canConnect(environmentId));
  const canManage = useAtomValue(inferenceProxy.manageInference.permissionAtom(environmentId));
  const enable = useAtomCommand(inferenceProxy.enableInferenceRouting, { reportFailure: false });
  const manage = useAtomCommand(inferenceProxy.manageInference, { reportFailure: false });
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<{ target: boolean; message: string } | null>(null);
  const { instanceId } = provider;
  const config = environment.serverConfig.settings.providerInstances[instanceId]?.config;
  const route = isInferenceProviderConfig(config) ? config : null;
  const enabled = isInferenceRoutingEnabled(config);
  const error = failure && failure.target !== enabled ? failure.message : "";
  const locked = isManagedSettingPath(
    environment.serverConfig.managedPolicy,
    `providerInstances.${instanceId}.config.inferenceEnabled`,
  );
  async function change(value: boolean) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setFailure(null);
    const result = value
      ? await enable({
          consumer: { environmentId, label: environment.label },
          environments,
          resolve: m,
          driver,
          ...(route
            ? { preferredHostId: route.inferenceHostId, preserveProviderEnabled: true }
            : {}),
        })
      : await manage({ environmentId, input: { operation: "removeRoute", instanceId } });
    inFlight.current = false;
    setPending(false);
    if (result._tag === "Success") {
      onRouteChange();
    } else {
      const cause = squashAtomCommandFailure(result);
      setFailure({
        target: value,
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
  return (
    <>
      <SettingsSwitchRow
        label={gt("{provider} inference routing", { provider: INFERENCE_HARNESSES[driver].label })}
        subtitle={
          error ||
          (enabled
            ? route
              ? gt("Using accounts on {host}.", {
                  host: route.inferenceHostLabel || environment.label,
                })
              : gt("This inference route is incomplete. Turn it off to use the native provider.")
            : gt("Use accounts on this environment or a paired inference host."))
        }
        value={enabled}
        disabled={pending || locked || (enabled ? !canManage : !canConnect)}
        onValueChange={(value) => void change(value)}
      />
      {error && !enabled && canManage ? (
        <ListActionRow label={gt("Set up accounts here")} onPress={onSetup} />
      ) : null}
    </>
  );
}

function HostedAccountRow({
  account,
  disabled,
  onRemove,
}: {
  account: InferenceProxyStatus["accounts"][number];
  disabled: boolean;
  onRemove: () => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const [revealed, setRevealed] = useState(false);
  const retryAfter = inferenceAccountRetryAfter(account);
  return (
    <View className="flex-row items-center pr-4">
      <View className="min-w-0 flex-1">
        <ListActionRow
          label={
            revealed
              ? account.name
              : gt("{provider} account · ••••••", { provider: account.provider })
          }
          description={
            retryAfter
              ? revealed
                ? gt("{status} · Retry after {time} · Tap to hide", {
                    status: inferenceAccountStatus(account, messages),
                    time: new Date(retryAfter).toLocaleString(),
                  })
                : gt("{status} · Retry after {time} · Tap to reveal", {
                    status: inferenceAccountStatus(account, messages),
                    time: new Date(retryAfter).toLocaleString(),
                  })
              : revealed
                ? gt("{status} · Tap to hide", {
                    status: inferenceAccountStatus(account, messages),
                  })
                : gt("{status} · Tap to reveal", {
                    status: inferenceAccountStatus(account, messages),
                  })
          }
          onPress={() => setRevealed(!revealed)}
        />
      </View>
      {revealed && (
        <ControlPill
          variant="pill"
          label={gt("Remove")}
          accessibilityLabel={gt("Remove {account}", { account: account.name })}
          disabled={disabled}
          onPress={onRemove}
        />
      )}
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
  const gt = useGT();
  return (
    <View className="gap-3">
      <SettingsSwitchRow
        label={gt("Round-robin routing")}
        subtitle={gt(
          "Distribute requests across eligible credentials. Turn off to use the first available credential.",
        )}
        value={routing.strategy === "round-robin"}
        disabled={disabled}
        onValueChange={(enabled) =>
          void run({ operation: "setRouting", strategy: enabled ? "round-robin" : "fill-first" })
        }
      />
      <SettingsSwitchRow
        label={gt("Keep sessions on one account")}
        subtitle={gt("Reuse the same credential for a conversation while it is available.")}
        value={routing.sessionAffinity}
        disabled={disabled}
        onValueChange={(sessionAffinity) => void run({ operation: "setRouting", sessionAffinity })}
      />
    </View>
  );
}

function InferenceControls({
  environment,
  setupDriver,
  onConnected,
  onOpenHostingSettings,
}: {
  environment: SettingsTarget;
  setupDriver: InferenceDriver | null;
  onConnected: () => void;
  onOpenHostingSettings: () => void;
}) {
  const gt = useGT();
  const { environmentId } = environment;
  const { environments } = useEnvironments();
  const query = useEnvironmentQuery(inferenceProxy.inferenceStatus({ environmentId, input: {} }));
  const command = useAtomCommand(inferenceProxy.manageInference, { reportFailure: false });
  const enableRouting = useAtomCommand(inferenceProxy.enableInferenceRouting, {
    reportFailure: false,
  });
  const permitted = useAtomValue(inferenceProxy.manageInference.permissionAtom(environmentId));
  const [pending, setPending] = useState(false);
  const [login, setLogin] = useState<{ url: string; state: string } | null>(null);
  const [callback, setCallback] = useState("");
  const [notice, setNotice] = useState<ReactNode>("");
  const accountSetup = useRef({ active: false });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- prevents an account operation from routing after its setup panel closes
  useEffect(() => {
    const setup = { active: true };
    accountSetup.current = setup;
    return () => {
      setup.active = false;
    };
  }, []);
  async function run(input: InferenceProxyAction) {
    const setup = accountSetup.current;
    setPending(true);
    setNotice("");
    const result = await command({ environmentId, input });
    if (!setup.active) return;
    if (result._tag === "Failure") {
      setPending(false);
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
      setNotice(<T>Sign-in failed or expired. Start a new sign-in.</T>);
    if (result.value.status === "wait")
      setNotice(<T>Waiting for the host to finish sign-in. Check status after a moment.</T>);
    if (
      setupDriver &&
      (result.value.status === "ok" ||
        (input.operation === "configure" && input.enabled && input.expectedEnabled === false))
    ) {
      const instanceId = defaultInstanceIdForDriver(ProviderDriverKind.make(setupDriver));
      const connected = await enableRouting({
        consumer: { environmentId, label: environment.label },
        environments,
        resolve: m,
        driver: setupDriver,
        onlyHostId: environmentId,
        ...(isInferenceProviderConfig(
          environment.serverConfig.settings.providerInstances[instanceId]?.config,
        )
          ? { preserveProviderEnabled: true }
          : {}),
      });
      if (!setup.active) return;
      if (connected._tag === "Success") onConnected();
      else {
        const failure = squashAtomCommandFailure(connected);
        setNotice(failure instanceof Error ? failure.message : String(failure));
      }
    }
    setPending(false);
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
  const requiresHostingSettings =
    setupDriver !== null &&
    host?.enabled === false &&
    environment.serverConfig.environment.capabilities.inferenceConfigureGuard !== true;
  return (
    <View className="gap-1">
      {host ? (
        <>
          {requiresHostingSettings ? (
            <ListActionRow
              label={gt("Manage inference hosting")}
              description={gt("Start hosting in Inference accounts, then turn on routing.")}
              disabled={disabled}
              onPress={onOpenHostingSettings}
            />
          ) : (
            <SettingsSwitchRow
              label={gt("Host accounts here")}
              subtitle={
                host.problem ??
                (host.running
                  ? gt("CLIProxyAPI {version} is running.", { version: host.version })
                  : gt("Enable to install and start CLIProxyAPI {version}.", {
                      version: host.version,
                    }))
              }
              disabled={disabled}
              value={host.enabled}
              onValueChange={(enabled) =>
                void run({
                  operation: "configure",
                  enabled,
                  sharing: false,
                  expectedEnabled: host.enabled,
                })
              }
            />
          )}
          {host.enabled && (
            <>
              <ListActionRow
                label={
                  available
                    ? gt("Update CLIProxyAPI to {version}", { version: available })
                    : gt("Check for CLIProxyAPI updates")
                }
                description={
                  updateQuery.error ??
                  (available
                    ? gt("Restarts the inference host.")
                    : gt("Installed version: {version}", { version: host.version }))
                }
                disabled={disabled || updateQuery.isPending}
                onPress={() =>
                  available ? void run({ operation: "update" }) : updateQuery.refresh()
                }
              />
              <SettingsSwitchRow
                label={gt("Share inference with paired environments")}
                subtitle={gt(
                  "Use Tailscale HTTPS or a trusted LAN. LAN HTTP sends requests and route keys unencrypted. Turning sharing off revokes remote access.",
                )}
                disabled={disabled}
                value={host.sharing}
                onValueChange={(sharing) =>
                  void run({
                    operation: "configure",
                    enabled: true,
                    sharing,
                    expectedEnabled: true,
                  })
                }
              />
              {host.routing && (
                <InferenceRoutingControls routing={host.routing} disabled={disabled} run={run} />
              )}
              {host.consumers.map((c) => (
                <ListActionRow
                  key={c.environmentId}
                  label={gt("Revoke access for {environment}", { environment: c.label })}
                  disabled={disabled}
                  onPress={() => void run({ operation: "revoke", environmentId: c.environmentId })}
                />
              ))}
              {host.accounts.map((account) => (
                <HostedAccountRow
                  key={account.name}
                  account={account}
                  disabled={disabled}
                  onRemove={() => void run({ operation: "removeAccount", name: account.name })}
                />
              ))}
              {login ? (
                <>
                  <ListActionRow
                    label={gt("Open sign-in page")}
                    description={gt(
                      "Paste the final localhost URL below, even if your browser cannot load it.",
                    )}
                    onPress={() =>
                      void Linking.openURL(login.url).catch(() =>
                        setNotice(<T>Could not open sign-in page.</T>),
                      )
                    }
                  />
                  <TextInput
                    accessibilityLabel={gt("Sign-in callback URL")}
                    placeholder={gt("Paste callback URL")}
                    secureTextEntry
                    autoCapitalize="none"
                    autoCorrect={false}
                    editable={!disabled}
                    value={callback}
                    onChangeText={setCallback}
                    className="mx-4 rounded-lg border border-border-subtle px-3 py-2 text-foreground"
                  />
                  <ListActionRow
                    label={gt("Submit callback")}
                    disabled={disabled || !callback}
                    onPress={() =>
                      void run({ operation: "callback", state: login.state, callback })
                    }
                  />
                  <ListActionRow
                    label={gt("Check sign-in status")}
                    disabled={disabled}
                    onPress={() => void run({ operation: "check", state: login.state })}
                  />
                  <ListActionRow
                    label={gt("Cancel sign-in")}
                    disabled={disabled}
                    onPress={() => void run({ operation: "cancel", state: login.state })}
                  />
                </>
              ) : (
                (setupDriver ? INFERENCE_HARNESSES[setupDriver].upstreams : upstreams).map(
                  (upstream) => (
                    <ListActionRow
                      key={upstream}
                      label={gt("Add {provider} account", {
                        provider: INFERENCE_UPSTREAMS[upstream],
                      })}
                      disabled={disabled}
                      onPress={() => void run({ operation: "signIn", upstream })}
                    />
                  ),
                )
              )}
            </>
          )}
        </>
      ) : (
        <AppText className="px-4 text-foreground-muted">
          {query.error ?? gt("Loading host status…")}
        </AppText>
      )}
      {notice ? (
        <AppText accessibilityLiveRegion="polite" className="px-4 text-foreground">
          {notice}
        </AppText>
      ) : null}
      <AppText className="px-4 text-foreground-muted">
        <T>
          Choose a host for inference. Tools run on <Var>{environment.label}</Var>. Choosing a host
          changes where this provider sends inference. That host manages the accounts.
        </T>
      </AppText>
      {host?.routes.map((route) => (
        <ListActionRow
          key={route.instanceId}
          label={gt("Use native {provider}", {
            provider: inferenceHarness(route.instanceId)?.label ?? route.instanceId,
          })}
          description={gt("Now: {route}", { route: route.label })}
          disabled={disabled}
          onPress={() => void run({ operation: "removeRoute", instanceId: route.instanceId })}
        />
      ))}
      {inferenceHostCandidates(environments, environmentId).map((host) => (
        <Route key={host.environmentId} host={host} consumer={environment} />
      ))}
    </View>
  );
}

export function InferenceAccounts({
  environment,
  providers,
}: {
  environment: SettingsTarget;
  providers: ReadonlyArray<ServerProvider>;
}) {
  const gt = useGT();
  const [panel, setPanel] = useState<"all" | InferenceDriver | null>(null);
  return (
    <>
      {providers.map((provider) => {
        const driver = INFERENCE_DRIVERS.find((candidate) => candidate === provider.driver);
        const instance = environment.serverConfig.settings.providerInstances[provider.instanceId];
        if (
          !driver ||
          provider.instanceId !== defaultInstanceIdForDriver(provider.driver) ||
          (instance && isCustomInferenceBackend(instance))
        )
          return null;
        return (
          <ProviderRoutingSwitch
            key={provider.instanceId}
            environment={environment}
            provider={provider}
            driver={driver}
            onSetup={() => setPanel(driver)}
            onRouteChange={() => setPanel((current) => (current === driver ? null : current))}
          />
        );
      })}
      <ListActionRow
        label={gt("Inference accounts")}
        description={
          panel
            ? gt("Hide hosting and account settings")
            : gt("Add accounts, share a host, or choose a specific route.")
        }
        onPress={() => setPanel(panel ? null : "all")}
      />
      {panel && (
        <InferenceControls
          key={panel}
          environment={environment}
          setupDriver={panel === "all" ? null : panel}
          onConnected={() => setPanel((current) => (current === panel ? null : current))}
          onOpenHostingSettings={() => setPanel("all")}
        />
      )}
    </>
  );
}
