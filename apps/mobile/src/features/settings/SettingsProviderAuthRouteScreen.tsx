import { StackActions, type StaticScreenProps, useNavigation } from "@react-navigation/native";
import { EnvironmentId, ProviderAuthSessionId, ProviderInstanceId } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { ActivityIndicator, Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { providerAuthEnvironment } from "../../state/provider-auth";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { TerminalSurface } from "../terminal/NativeTerminalSurface";
import { parseProviderAuthRouteParams, type ProviderAuthRouteParams } from "./providerAuthRoute";

type Props = StaticScreenProps<ProviderAuthRouteParams>;

export function SettingsProviderAuthRouteScreen({ route }: Props) {
  const params = parseProviderAuthRouteParams(route.params);
  return params === null ? <InvalidProviderAuthRouteScreen /> : <ProviderAuthScreen {...params} />;
}

function InvalidProviderAuthRouteScreen() {
  const navigation = useNavigation();
  useEffect(() => {
    navigation.dispatch(StackActions.replace("SettingsProviders"));
  }, [navigation]);
  return null;
}

function ProviderAuthScreen(params: ProviderAuthRouteParams) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const environmentId = EnvironmentId.make(params.environmentId);
  const instanceId = ProviderInstanceId.make(params.instanceId);
  const [sessionId, setSessionId] = useState<ProviderAuthSessionId | null>(() =>
    params.sessionId ? ProviderAuthSessionId.make(params.sessionId) : null,
  );
  const [startError, setStartError] = useState<string | null>(null);
  const start = useAtomCommand(providerAuthEnvironment.start, { reportFailure: false });
  const write = useAtomCommand(providerAuthEnvironment.write, { reportFailure: false });
  const resize = useAtomCommand(providerAuthEnvironment.resize, { reportFailure: false });
  const cancel = useAtomCommand(providerAuthEnvironment.cancel, { reportFailure: false });
  const attach = useEnvironmentQuery(
    sessionId === null
      ? null
      : providerAuthEnvironment.attach({ environmentId, input: { sessionId } }),
  );
  const snapshot = attach.data;

  useEffect(() => {
    if (sessionId !== null || params.sessionId) return;
    let active = true;
    void start({
      environmentId,
      input: { instanceId, action: params.action, cols: 60, rows: 20 },
    }).then((result) => {
      if (!active) return;
      if (result._tag === "Success") {
        setSessionId(result.value.sessionId);
      } else {
        setStartError("The provider authentication session could not be started.");
      }
    });
    return () => {
      active = false;
    };
  }, [environmentId, instanceId, params.action, params.sessionId, sessionId, start]);

  const running = snapshot?.status === "running" || (sessionId === null && startError === null);
  const message = startError ?? attach.error ?? snapshot?.message ?? null;

  return (
    <View className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title={params.displayName} onBack={() => navigation.goBack()} />
        </>
      ) : (
        <NativeStackScreenOptions options={{ title: params.displayName }} />
      )}
      <View
        className="flex-1 gap-3 px-4 pt-3"
        style={{ paddingBottom: Math.max(insets.bottom, 12) }}
      >
        {sessionId ? (
          <TerminalSurface
            terminalKey={`provider-auth:${sessionId}`}
            buffer={snapshot?.history ?? ""}
            isRunning={running}
            onInput={(data) => void write({ environmentId, input: { sessionId, data } })}
            onResize={({ cols, rows }) =>
              void resize({ environmentId, input: { sessionId, cols, rows } })
            }
            style={{ flex: 1 }}
          />
        ) : (
          <View className="flex-1 items-center justify-center gap-3">
            {startError === null ? <ActivityIndicator /> : null}
            <Text className="text-center text-foreground-muted">
              {startError ?? "Starting provider authentication…"}
            </Text>
          </View>
        )}
        {message ? <Text className="text-sm text-foreground-muted">{message}</Text> : null}
        {snapshot?.status === "running" && sessionId ? (
          <Pressable
            className="items-center rounded-xl border border-border px-4 py-3"
            onPress={() => void cancel({ environmentId, input: { sessionId } })}
          >
            <Text className="font-t3-medium text-destructive">Cancel session</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
