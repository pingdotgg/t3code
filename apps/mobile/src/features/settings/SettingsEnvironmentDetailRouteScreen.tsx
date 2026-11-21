import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { serverUpdateFailureText } from "@t3tools/client-runtime/state/server";
import { T, useGT, useMessages, Var } from "gt-react-native";
import * as Dialog from "../../components/ui/Dialog";
import { useAtom, useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  AuthProvidersManageScope,
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type ServerProvider,
} from "@t3tools/contracts";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { managedUpdatesDenial } from "@t3tools/client-runtime/contract-labels";
import { sessionPermissionsUnavailableMessage } from "@t3tools/shared/authScopeOptions";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";
import { View } from "react-native";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { m } from "../../i18n/messages";

import { AppText as Text } from "../../components/ui/AppText";
import { ProviderIcon } from "../../components/ProviderIcon";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { environmentSession, useEnvironmentScope, readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useRemoteConnections } from "../../state/use-remote-environment-registry";
import { ConnectionEnvironmentRow } from "../connection/ConnectionEnvironmentRow";
import { EnvironmentRoutesSection } from "./EnvironmentRoutesSection";
import { OutdatedServerUpdateSection } from "./OutdatedServerUpdateSection";
import { ListActionRow as SettingsActionRow } from "../../components/ui/ListActionRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import {
  canMaintainEnvironment,
  canUpdateEnvironmentProvider,
  supportsEnvironmentUpdate,
} from "./environment-maintenance";
import { environmentReleaseCheckAtom, releaseCheckValue } from "./environmentUpdateCheck";

export function SettingsEnvironmentDetailRouteScreen({
  route,
}: StaticScreenProps<{
  readonly environmentId: EnvironmentId;
}>) {
  return (
    <EnvironmentDetail
      key={route.params.environmentId}
      environmentId={route.params.environmentId}
    />
  );
}

function EnvironmentDetail({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const messages = useMessages();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const connections = useRemoteConnections();
  const environment = connections.connectedEnvironments.find(
    (entry) => entry.environmentId === environmentId,
  );
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const session = useAtomValue(environmentSession.sessionStateValueAtom(environmentId));
  const sessionResult = useAtomValue(environmentSession.sessionStateAtom(environmentId));
  const updateState = useAtomValue(serverEnvironment.updateStateAtom(environmentId));
  const outdated =
    useAtomValue(environmentPresentations.presentationAtom(environmentId))?.entry
      .serverUpdateRequired === true;
  const updateServer = useAtomCommand(serverEnvironment.updateServer);
  const updateProvider = useAtomCommand(serverEnvironment.updateProvider);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders);
  const [connectionExpanded, setConnectionExpanded] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [releaseCheck, checkRelease] = useAtom(environmentReleaseCheckAtom(environmentId), {
    mode: "promiseExit",
  });
  const release = releaseCheckValue(releaseCheck);

  const connected = environment?.isEnabled === true && environment.connectionState === "connected";
  const allowed =
    !AsyncResult.isFailure(sessionResult) && canMaintainEnvironment(session, connected);
  const running = updateState.status === "running";
  const providerBusy =
    config?.providers.some(
      (provider) =>
        provider.updateState?.status === "running" || provider.updateState?.status === "queued",
    ) ?? false;
  const canManageProviders = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const busy = !connected || pending !== null || running || providerBusy;
  const disabled = !allowed || busy;
  const version = config?.environment.serverVersion;
  const checkedRelease = release?.fromVersion === version ? release : null;
  const capabilities = config?.environment.capabilities;
  const managedPolicy = config?.managedPolicy;
  const supportUrl = managedPolicy?.supportUrl;
  // The server refuses checks and installs; say so instead of offering them.
  const updatesDenial = managedUpdatesDenial(managedPolicy, messages);

  async function run(label: string, action: () => Promise<void>) {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(label);
    setError(null);
    setNotice(null);
    const result = await settlePromise(action);
    pendingRef.current = false;
    setPending(null);
    if (AsyncResult.isFailure(result)) {
      const cause = squashAtomCommandFailure(result);
      setError(
        cause instanceof Error
          ? (errorDisplayMessage(cause, m) ?? cause.message)
          : gt("The action could not be completed. Try again."),
      );
    }
  }

  function requestServerUpdate() {
    const targetVersion = checkedRelease?.targetVersion;
    if (disabled || !targetVersion || !capabilities || !supportsEnvironmentUpdate(capabilities))
      return;
    Dialog.alert(
      environment
        ? gt("Update {environment}?", { environment: environment.environmentLabel })
        : gt("Update environment?"),
      capabilities.serverSelfUpdate === "desktop-managed"
        ? gt(
            "Install {product} {version}. The desktop app will close and relaunch. Running threads may be interrupted.",
            { product: "T3 Code", version: targetVersion },
          )
        : gt(
            "Install {product} {version}. The server will restart and reconnect. Running threads may be interrupted.",
            { product: "T3 Code", version: targetVersion },
          ),
      [
        { text: gt("Cancel"), style: "cancel" },
        {
          text: gt("Update", { $context: "verb, install an update" }),
          onPress: () =>
            void run("server", async () => {
              if (
                AsyncResult.isFailure(
                  appAtomRegistry.get(environmentSession.sessionStateAtom(environmentId)),
                ) ||
                !canMaintainEnvironment(
                  appAtomRegistry.get(environmentSession.sessionStateValueAtom(environmentId)),
                  connected,
                )
              )
                return;
              const result = await updateServer({
                environmentId,
                input: { targetVersion },
              });
              if (AsyncResult.isFailure(result)) throw squashAtomCommandFailure(result);
              setNotice(gt("Updated to {version}.", { version: result.value.targetVersion }));
            }),
        },
      ],
    );
  }

  function requestProviderUpdate(provider: ServerProvider) {
    if (
      busy ||
      !readEnvironmentScope(environmentId, AuthProvidersManageScope) ||
      !canUpdateEnvironmentProvider(provider)
    )
      return;
    void run(provider.instanceId, async () => {
      const result = await updateProvider({
        environmentId,
        input: {
          provider: provider.driver,
          instanceId: provider.instanceId,
        },
      });
      if (AsyncResult.isFailure(result)) throw squashAtomCommandFailure(result);
    });
  }

  return (
    <SettingsScreen title={environment?.environmentLabel ?? gt("Environment")}>
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {!environment ? (
          <Text className="text-base text-foreground-muted">
            <T>This environment is no longer saved on this device.</T>
          </Text>
        ) : (
          <>
            <SettingsSection title={gt("Connection")}>
              <ConnectionEnvironmentRow
                environment={environment}
                expanded={connectionExpanded}
                onToggle={() => setConnectionExpanded((value) => !value)}
                onReconnect={connections.onReconnectEnvironment}
                onRemove={connections.onRemoveEnvironmentPress}
                onSetEnabled={connections.onSetEnvironmentEnabled}
                onUpdate={connections.onUpdateEnvironment}
              />
            </SettingsSection>
            <EnvironmentRoutesSection
              environmentId={environmentId}
              connected={connected}
              onAddRoute={() =>
                navigation.navigate("SettingsEnvironmentNew", { routeFor: environmentId })
              }
            />
            {outdated ? (
              <OutdatedServerUpdateSection
                environmentId={environmentId}
                label={environment.environmentLabel}
              />
            ) : !connected ? (
              <Text className="px-2 text-sm text-foreground-muted">
                <T>Connect this environment to manage it.</T>
              </Text>
            ) : !allowed ? (
              <Text className="px-2 text-sm text-foreground-muted">
                {AsyncResult.isFailure(sessionResult) || session === null || !session.authenticated
                  ? sessionPermissionsUnavailableMessage(
                      {
                        connected,
                        failed: AsyncResult.isFailure(sessionResult),
                        rejected:
                          !AsyncResult.isFailure(sessionResult) && session?.authenticated === false,
                      },
                      messages,
                    )
                  : gt("This connection does not have permission to manage the environment.")}
              </Text>
            ) : null}
            {error ? (
              <Text selectable className="px-2 text-sm text-danger-foreground">
                {error}
              </Text>
            ) : null}
            {notice ? <Text className="px-2 text-sm text-foreground-muted">{notice}</Text> : null}
            {config && !outdated ? (
              <>
                <SettingsSection title="T3 Code">
                  <View className="gap-1 p-4">
                    <Text className="text-base text-foreground">
                      <T>
                        Version <Var>{version}</Var>
                      </T>
                    </Text>
                    {managedPolicy ? (
                      <Text className="text-sm text-foreground-muted">
                        <T>
                          Managed by <Var>{managedPolicy.organization}</Var>
                        </T>
                      </Text>
                    ) : null}
                    {updatesDenial ? (
                      <Text className="text-sm text-foreground-muted">{updatesDenial}</Text>
                    ) : null}
                    {running ? (
                      <Text className="text-sm text-foreground-muted">
                        {updateState.stage === "resuming"
                          ? gt("Restarting and reconnecting…")
                          : gt("Downloading update…")}
                      </Text>
                    ) : updateState.status === "failed" ? (
                      <Text selectable className="text-sm text-danger-foreground">
                        {serverUpdateFailureText(updateState, messages)}
                      </Text>
                    ) : null}
                    {checkedRelease && !updatesDenial ? (
                      <Text className="text-sm text-foreground-muted">
                        {checkedRelease.targetVersion
                          ? gt("Version {version} is available.", {
                              version: checkedRelease.targetVersion,
                            })
                          : gt("You are up to date.")}
                      </Text>
                    ) : null}
                    {checkedRelease?.targetVersion &&
                    !updatesDenial &&
                    !supportsEnvironmentUpdate(config.environment.capabilities) ? (
                      <Text className="text-sm text-foreground-muted">
                        {capabilities?.serverSelfUpdate === "desktop-managed"
                          ? gt("Update the desktop app on this machine.")
                          : gt("Update and restart {product} on this machine.", {
                              product: "T3 Code",
                            })}
                      </Text>
                    ) : null}
                  </View>
                  {supportUrl ? (
                    <SettingsActionRow
                      icon="questionmark.bubble"
                      label={gt("Get help from {organization}", {
                        organization: managedPolicy.organization,
                      })}
                      onPress={() => void tryOpenExternalUrl(supportUrl)}
                    />
                  ) : null}
                  {updatesDenial ? null : (
                    <SettingsActionRow
                      icon="arrow.clockwise"
                      label={gt("Check for updates")}
                      disabled={disabled}
                      loading={pending === "check"}
                      onPress={() => {
                        if (disabled) return;
                        const fromVersion = config.environment.serverVersion;
                        void run("check", async () => {
                          const exit = await checkRelease(async () => fromVersion);
                          // `run` owns the error message, so a failed lookup rethrows to it.
                          if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
                        });
                      }}
                    />
                  )}
                  {checkedRelease?.targetVersion &&
                  !updatesDenial &&
                  supportsEnvironmentUpdate(config.environment.capabilities) ? (
                    <SettingsActionRow
                      icon="arrow.up.circle"
                      label={gt("Update to {version}", { version: checkedRelease.targetVersion })}
                      disabled={disabled}
                      loading={pending === "server" || running}
                      onPress={requestServerUpdate}
                    />
                  ) : null}
                </SettingsSection>
                <SettingsSection title={gt("Providers")}>
                  <SettingsActionRow
                    icon="arrow.clockwise"
                    label={gt("Refresh providers")}
                    disabled={busy || !canRead}
                    loading={pending === "refresh"}
                    onPress={() => {
                      if (busy || !canRead) return;
                      void run("refresh", async () => {
                        if (!readEnvironmentScope(environmentId, AuthOrchestrationReadScope))
                          return;
                        const result = await refreshProviders({
                          environmentId,
                          input: { reloadSecrets: true },
                        });
                        if (AsyncResult.isFailure(result)) throw squashAtomCommandFailure(result);
                        setNotice(gt("Provider status refreshed."));
                      });
                    }}
                  />
                  {config.providers
                    .filter((provider) => provider.enabled)
                    .map((provider) => (
                      <View key={provider.instanceId}>
                        <View className="gap-1 p-4">
                          <View className="flex-row items-center gap-2">
                            <ProviderIcon
                              provider={provider.driver}
                              iconUrl={provider.iconUrl}
                              size={18}
                            />
                            <Text className="min-w-0 flex-1 text-base font-t3-medium text-foreground">
                              {provider.displayName ?? provider.driver}
                            </Text>
                          </View>
                          <Text className="text-sm text-foreground-muted">
                            {provider.versionAdvisory?.latestVersion
                              ? gt("{version} · Latest {latest}", {
                                  version: provider.installed
                                    ? (provider.version ?? gt("Version unknown"))
                                    : gt("Not installed"),
                                  latest: provider.versionAdvisory.latestVersion,
                                })
                              : provider.installed
                                ? (provider.version ?? gt("Version unknown"))
                                : gt("Not installed")}
                          </Text>
                          {provider.versionAdvisory?.status === "unknown" &&
                          provider.versionAdvisory.latestVersionCheckFailed === true ? (
                            <Text className="text-sm text-foreground-muted">
                              {gt("Could not check for updates")}
                            </Text>
                          ) : null}
                          {provider.updateState && provider.updateState.status !== "idle" ? (
                            <Text
                              selectable
                              className={
                                provider.updateState.status === "failed"
                                  ? "text-sm text-danger-foreground"
                                  : "text-sm text-foreground-muted"
                              }
                            >
                              {provider.updateState.message ??
                                {
                                  queued: gt("Update queued"),
                                  running: gt("Update running"),
                                  succeeded: gt("Update succeeded"),
                                  failed: gt("Update failed"),
                                  unchanged: gt("Update unchanged"),
                                }[provider.updateState.status]}
                            </Text>
                          ) : null}
                          {provider.compatibilityAdvisory?.message ? (
                            <Text selectable className="text-sm text-foreground-muted">
                              {provider.compatibilityAdvisory.message}
                            </Text>
                          ) : null}
                          {provider.unavailableReason || provider.message ? (
                            <Text selectable className="text-sm text-foreground-muted">
                              {provider.unavailableReason ?? provider.message}
                            </Text>
                          ) : null}
                          {provider.versionAdvisory?.status === "behind_latest" &&
                          !provider.versionAdvisory.canUpdate ? (
                            <Text className="text-sm text-foreground-muted">
                              <T>Update this provider on the environment's machine.</T>
                            </Text>
                          ) : null}
                        </View>
                        {canUpdateEnvironmentProvider(provider) ? (
                          <SettingsActionRow
                            icon="arrow.up.circle"
                            label={gt("Update {provider}", {
                              provider: provider.displayName ?? provider.driver,
                            })}
                            disabled={busy || !canManageProviders}
                            loading={pending === provider.instanceId}
                            onPress={() => requestProviderUpdate(provider)}
                          />
                        ) : null}
                      </View>
                    ))}
                </SettingsSection>
              </>
            ) : null}
          </>
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}
