import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import {
  ANTIGRAVITY_AUTH_METHODS,
  AuthOrchestrationOperateScope,
  EnvironmentId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ProviderIcon } from "../../components/ProviderIcon";
import { cn } from "../../lib/cn";
import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { appAtomRegistry } from "../../state/atom-registry";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { environmentSession } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  antigravityEnabledPatch,
  readAntigravityAuthMethod,
  resolveProviderSignInPresentation,
} from "./provider-setup-state";

export type ProviderSetupRouteParams = {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
};

const PRIVATE_COMMAND_OPTIONS = { reportFailure: false, reportDefect: false } as const;
const isEnvironmentId = Schema.is(EnvironmentId);
const isProviderInstanceId = Schema.is(ProviderInstanceId);

function SetupButton(props: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly primary?: boolean;
  readonly destructive?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      className={cn(
        "min-h-11 items-center justify-center border border-white/25 px-4 py-3 active:opacity-70 disabled:opacity-40",
        props.primary && "bg-white",
      )}
    >
      <Text
        className={cn(
          "text-base font-t3-medium text-white",
          props.primary && "text-black",
          props.destructive && "text-red-400",
        )}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

/** The same screen stays inside Settings or the current model picker. */
export function SettingsProviderSetupRouteScreen({
  route,
}: StaticScreenProps<ProviderSetupRouteParams>) {
  if (
    !isEnvironmentId(route.params?.environmentId) ||
    !isProviderInstanceId(route.params?.instanceId)
  ) {
    return (
      <View className="flex-1 bg-black p-5">
        <Text className="text-base text-white">This provider link is not valid.</Text>
      </View>
    );
  }
  return (
    <ProviderSetupScreen
      key={`${route.params.environmentId}:${route.params.instanceId}`}
      {...route.params}
    />
  );
}

function ProviderSetupScreen({ environmentId, instanceId }: ProviderSetupRouteParams) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { presentationById } = useEnvironments();
  const environment = presentationById.get(environmentId);
  const environmentLabel = environment?.entry.target.label ?? "this environment";
  const isConnected = environment?.connection.phase === "connected";
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const provider = config?.providers.find((item) => item.instanceId === instanceId);
  const access = useEnvironmentQuery(environmentSession.sessionStateAtom(environmentId));
  const canOperate =
    access.data?.authenticated === true &&
    access.data.scopes?.includes(AuthOrchestrationOperateScope) === true;
  const target = { environmentId, input: { instanceId } };
  const authQuery = useEnvironmentQuery(
    canOperate && provider?.setup?.canAuthenticate
      ? serverEnvironment.providerAuthState(target)
      : null,
  );
  const installQuery = useEnvironmentQuery(
    canOperate && provider?.setup?.canInstall
      ? serverEnvironment.providerInstallState(target)
      : null,
  );
  const auth = authQuery.data;
  const installation = installQuery.data;
  const startAuth = useAtomCommand(serverEnvironment.startProviderAuth, PRIVATE_COMMAND_OPTIONS);
  const completeAuth = useAtomCommand(
    serverEnvironment.completeProviderAuth,
    PRIVATE_COMMAND_OPTIONS,
  );
  const cancelAuth = useAtomCommand(serverEnvironment.cancelProviderAuth, PRIVATE_COMMAND_OPTIONS);
  const logout = useAtomCommand(serverEnvironment.logoutProviderAuth, PRIVATE_COMMAND_OPTIONS);
  const startInstall = useAtomCommand(
    serverEnvironment.startProviderInstall,
    PRIVATE_COMMAND_OPTIONS,
  );
  const cancelInstall = useAtomCommand(
    serverEnvironment.cancelProviderInstall,
    PRIVATE_COMMAND_OPTIONS,
  );
  const removeInstall = useAtomCommand(
    serverEnvironment.removeProviderInstallation,
    PRIVATE_COMMAND_OPTIONS,
  );
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, PRIVATE_COMMAND_OPTIONS);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const authActive =
    auth?.phase === "starting" || auth?.phase === "waiting" || auth?.phase === "verifying";
  const installActive =
    installation?.phase === "downloading" ||
    installation?.phase === "extracting" ||
    installation?.phase === "verifying";
  const controlsDisabled = busy || !isConnected || !canOperate;
  const {
    signedIn,
    showSignOut,
    message: authMessage,
  } = resolveProviderSignInPresentation(provider, auth);
  const authMethod = readAntigravityAuthMethod(
    config?.settings.providerInstances[instanceId]?.config ??
      (instanceId === "antigravity" ? config?.settings.providers.antigravity : undefined),
  );
  const usesBrowser = authMethod === "oauth-personal" || authMethod === "oauth-business";
  const methodLabel =
    ANTIGRAVITY_AUTH_METHODS.find((method) => method.value === authMethod)?.label ??
    "Google account";

  // Return URLs never enter saved drafts, navigation params, or diagnostics.
  useEffect(() => {
    setCallbackUrl("");
  }, [auth?.flowId, auth?.phase]);

  const perform = useCallback(
    async (command: () => Promise<AtomCommandResult<unknown, unknown>>, failureMessage: string) => {
      if (busyRef.current || !isConnected || !canOperate) return false;
      busyRef.current = true;
      setBusy(true);
      setError(null);
      try {
        const result = await command();
        if (!AsyncResult.isSuccess(result)) {
          setError(failureMessage);
          return false;
        }
        return true;
      } catch {
        setError(failureMessage);
        return false;
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [canOperate, isConnected],
  );

  const setEnabled = (enabled: boolean) => {
    const currentConfig = appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId));
    const currentProvider = currentConfig?.providers.find((item) => item.instanceId === instanceId);
    if (!currentConfig || !currentProvider) return;
    const patch = antigravityEnabledPatch(currentConfig.settings, currentProvider, enabled);
    if (!patch) return;
    void perform(
      () => updateSettings({ environmentId, input: { patch } }),
      "Could not change this provider. Reconnect and try again.",
    );
  };

  const title = provider?.displayName ?? "Antigravity";
  return (
    <View className="flex-1 bg-black">
      <NativeStackScreenOptions
        options={{
          title,
          headerShown: Platform.OS !== "android",
          headerTransparent: false,
          headerStyle: { backgroundColor: "#000" },
          headerTintColor: "#fff",
          contentStyle: { backgroundColor: "#000" },
        }}
      />
      {Platform.OS === "android" ? (
        <AndroidScreenHeader title={title} onBack={() => navigation.goBack()} />
      ) : null}
      <ScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-5 px-5 pt-5"
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View className="flex-row items-center gap-3">
          <ProviderIcon provider="antigravity" size={28} />
          <Text className="min-w-0 flex-1 text-base text-white">{environmentLabel}</Text>
        </View>
        {!isConnected ? (
          <Text className="text-base text-white">
            Reconnect to this environment to continue setup.
          </Text>
        ) : access.error ? (
          <View className="gap-3">
            <Text className="text-base text-white">Could not check your environment access.</Text>
            <SetupButton label="Retry" onPress={access.refresh} />
          </View>
        ) : !access.data ? (
          <Text className="text-base text-white">Checking environment access.</Text>
        ) : !canOperate ? (
          <Text className="text-base text-white">
            This connection cannot manage providers. Pair again with permission to operate this
            environment.
          </Text>
        ) : null}
        {!config ? (
          <Text className="text-base text-white">Loading provider settings.</Text>
        ) : !provider || provider.driver !== "antigravity" ? (
          <Text className="text-base text-white">
            This provider is not available on this environment.
          </Text>
        ) : (
          <>
            <View className="gap-3">
              <Text className="text-base text-white">
                {provider.enabled ? "Enabled" : "Disabled"}
                {provider.installed
                  ? `. Installed${provider.version ? ` ${provider.version}` : ""}`
                  : ". Not installed"}
              </Text>
              <SetupButton
                label={provider.enabled ? "Disable Antigravity" : "Enable Antigravity"}
                disabled={controlsDisabled}
                onPress={() => {
                  if (!provider.enabled) {
                    setEnabled(true);
                    return;
                  }
                  Alert.alert(
                    "Disable Antigravity?",
                    `This stops Antigravity sessions on ${environmentLabel}. Google credentials stay saved.`,
                    [
                      { text: "Cancel", style: "cancel" },
                      { text: "Disable", style: "destructive", onPress: () => setEnabled(false) },
                    ],
                  );
                }}
              />
            </View>
            {provider.setup?.canInstall ? (
              <View className="gap-3 border-t border-white/20 pt-4">
                {installActive ? (
                  <>
                    <Text accessibilityLiveRegion="polite" className="text-base text-white">
                      {installation.phase === "downloading"
                        ? `Downloading ${Math.round(installation.downloadedBytes / 1_048_576)}${installation.totalBytes === null ? "" : ` of ${Math.round(installation.totalBytes / 1_048_576)}`} MB`
                        : installation.phase === "extracting"
                          ? "Extracting Antigravity files."
                          : "Checking the Antigravity installation."}
                    </Text>
                    <SetupButton
                      label="Cancel install"
                      disabled={controlsDisabled || installation.operationId === null}
                      onPress={() => {
                        const operationId = installation.operationId;
                        if (!operationId) return;
                        void perform(
                          () =>
                            cancelInstall({ environmentId, input: { instanceId, operationId } }),
                          "Could not cancel the install. Try again.",
                        );
                      }}
                    />
                  </>
                ) : !provider.installed ? (
                  <SetupButton
                    label={
                      installation?.phase === "failed" || installation?.phase === "cancelled"
                        ? "Retry install"
                        : "Install Antigravity"
                    }
                    primary
                    disabled={controlsDisabled || authActive}
                    onPress={() =>
                      void perform(
                        () => startInstall(target),
                        "Could not start the install. Try again.",
                      )
                    }
                  />
                ) : null}
                {installation?.message ? (
                  <Text className="text-sm text-white">{installation.message}</Text>
                ) : null}
                {installation?.canRemove && !installActive ? (
                  <SetupButton
                    label="Remove managed install"
                    destructive
                    disabled={controlsDisabled || authActive}
                    onPress={() => {
                      Alert.alert(
                        "Remove the Antigravity install?",
                        `This removes T3's managed install from ${environmentLabel}. Providers that use it will need it installed again. Google credentials and threads stay.`,
                        [
                          { text: "Cancel", style: "cancel" },
                          {
                            text: "Remove",
                            style: "destructive",
                            onPress: () =>
                              void perform(
                                () => removeInstall(target),
                                "Could not remove the managed install. Try again.",
                              ),
                          },
                        ],
                      );
                    }}
                  />
                ) : null}
                {installQuery.error ? (
                  <Text className="text-sm text-white">
                    Install status is unavailable. Reconnect and try again.
                  </Text>
                ) : null}
              </View>
            ) : !provider.installed ? (
              <Text className="text-base text-white">
                Antigravity cannot be installed on this environment. Use a supported server host or
                set an executable path in provider settings.
              </Text>
            ) : null}
            {provider.setup?.canAuthenticate ? (
              <View className="gap-3 border-t border-white/20 pt-4">
                <Text className="text-lg font-t3-medium text-white">{methodLabel}</Text>
                <Text className="text-base text-white">
                  {signedIn
                    ? "Signed in. Credentials stay on this environment."
                    : provider.auth.status === "unknown"
                      ? "Sign-in has not been checked."
                      : usesBrowser
                        ? "Sign in with the Google account you use for Antigravity."
                        : "Connect with the credentials set in provider settings on web or desktop."}
                </Text>
                {authActive ? (
                  <>
                    <Text accessibilityLiveRegion="polite" className="text-base text-white">
                      {auth.phase === "starting"
                        ? usesBrowser
                          ? "Starting Google sign-in."
                          : "Checking credentials."
                        : auth.phase === "verifying"
                          ? usesBrowser
                            ? "Checking Google sign-in."
                            : "Checking credentials."
                          : auth.authorizationUrl
                            ? "Complete sign-in in your browser."
                            : "Sign-in is open on another client. Complete it there or wait for it to expire."}
                    </Text>
                    {auth.authorizationUrl && auth.phase === "waiting" ? (
                      <>
                        <SetupButton
                          label="Open Google sign-in"
                          primary
                          disabled={controlsDisabled}
                          onPress={() => {
                            if (!auth.authorizationUrl) return;
                            void tryOpenExternalUrl(auth.authorizationUrl, "provider-auth").then(
                              (opened) => {
                                if (!opened)
                                  setError(
                                    "Could not open Google sign-in. Copy the link and open it in your browser.",
                                  );
                              },
                            );
                          }}
                        />
                        <SetupButton
                          label="Copy sign-in link"
                          disabled={controlsDisabled}
                          onPress={() => {
                            if (!auth.authorizationUrl) return;
                            void tryCopyTextWithHaptic(auth.authorizationUrl, {
                              target: "provider-sign-in-link",
                            }).then((copied) => {
                              if (!copied) setError("Could not copy the sign-in link.");
                            });
                          }}
                        />
                        <Text className="text-sm leading-5 text-white">
                          After sign-in, the browser will open a 127.0.0.1 address that cannot load
                          on your phone. Copy that full address and paste it here.
                        </Text>
                        <TextInput
                          accessibilityLabel="Google sign-in return URL"
                          autoCapitalize="none"
                          autoComplete="off"
                          autoCorrect={false}
                          className="min-h-12 rounded-none border border-white/25 bg-black px-3 py-3 text-base text-white"
                          editable={!controlsDisabled}
                          keyboardType="url"
                          onChangeText={setCallbackUrl}
                          placeholder="http://127.0.0.1:.../"
                          textContentType="none"
                          value={callbackUrl}
                        />
                        <SetupButton
                          label="Complete sign-in"
                          primary
                          disabled={
                            controlsDisabled || callbackUrl.trim().length === 0 || !auth.flowId
                          }
                          onPress={() => {
                            const flowId = auth.flowId;
                            if (!flowId) return;
                            const submittedUrl = callbackUrl.trim();
                            setCallbackUrl("");
                            void perform(
                              () =>
                                completeAuth({
                                  environmentId,
                                  input: { instanceId, flowId, callbackUrl: submittedUrl },
                                }),
                              "Could not complete Google sign-in. Check the return URL and try again.",
                            );
                          }}
                        />
                      </>
                    ) : null}
                    {auth.expiresAt ? (
                      <Text className="text-sm text-white">
                        Sign-in expires at{" "}
                        {new Date(auth.expiresAt).toLocaleTimeString([], {
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                        .
                      </Text>
                    ) : null}
                    {auth.flowId ? (
                      <SetupButton
                        label="Cancel sign-in"
                        disabled={controlsDisabled}
                        onPress={() => {
                          const flowId = auth.flowId;
                          if (!flowId) return;
                          setCallbackUrl("");
                          void perform(
                            () => cancelAuth({ environmentId, input: { instanceId, flowId } }),
                            "Could not cancel sign-in. Try again.",
                          );
                        }}
                      />
                    ) : null}
                  </>
                ) : showSignOut ? (
                  <SetupButton
                    label={usesBrowser ? "Sign out of Google" : "Disconnect"}
                    destructive
                    disabled={controlsDisabled}
                    onPress={() => {
                      Alert.alert(
                        usesBrowser ? "Sign out of Google?" : "Disconnect Antigravity?",
                        `This stops Antigravity sessions for ${title} on ${environmentLabel}. Threads and files stay.`,
                        [
                          { text: "Cancel", style: "cancel" },
                          {
                            text: "Sign out",
                            style: "destructive",
                            onPress: () =>
                              void perform(
                                () => logout(target),
                                "Could not sign out of Google. Try again.",
                              ),
                          },
                        ],
                      );
                    }}
                  />
                ) : (
                  <SetupButton
                    label={
                      usesBrowser
                        ? auth?.phase === "failed" || auth?.phase === "cancelled"
                          ? "Retry Google sign-in"
                          : "Sign in with Google"
                        : auth?.phase === "failed" || auth?.phase === "cancelled"
                          ? "Retry connection"
                          : "Connect"
                    }
                    primary
                    disabled={
                      controlsDisabled ||
                      !provider.enabled ||
                      !provider.installed ||
                      installActive ||
                      authQuery.isPending
                    }
                    onPress={() =>
                      void perform(
                        () => startAuth(target),
                        "Could not start Google sign-in. Try again.",
                      )
                    }
                  />
                )}
                {!provider.enabled && !signedIn ? (
                  <Text className="text-sm text-white">Enable Antigravity to sign in.</Text>
                ) : !provider.installed && !signedIn ? (
                  <Text className="text-sm text-white">Install Antigravity to sign in.</Text>
                ) : null}
                {authMessage ? <Text className="text-sm text-white">{authMessage}</Text> : null}
                {authQuery.error ? (
                  <Text className="text-sm text-white">
                    Sign-in status is unavailable. Reconnect and try again.
                  </Text>
                ) : null}
              </View>
            ) : null}
            {provider.message ? (
              <Text className="text-sm text-white">{provider.message}</Text>
            ) : null}
          </>
        )}
        {error ? (
          <Text accessibilityRole="alert" className="text-base text-red-400">
            {error}
          </Text>
        ) : null}
        {busy ? (
          <Text accessibilityLiveRegion="polite" className="text-sm text-white">
            Waiting for the environment.
          </Text>
        ) : null}
      </ScrollView>
    </View>
  );
}
