import { useAtomValue } from "@effect/atom-react";
import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, HostScreenError, type HostScreenFrame } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { useEffect, useEffectEvent, useState } from "react";
import { Image, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ControlPill } from "../../components/ui/ControlPill";
import { SheetCloseButton } from "../../components/ui/SheetHeader";
import { useAppForeground } from "../../lib/appState";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

const isHostScreenError = Schema.is(HostScreenError);

export function HostScreenRouteScreen({
  route,
}: StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const focused = useIsFocused();
  const foreground = useAppForeground();
  const [attempt, setAttempt] = useState(0);
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const allowed = useAtomValue(serverEnvironment.captureHostScreen.permissionAtom(environmentId));
  return (
    <View
      className="flex-1 bg-background"
      style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
    >
      <View className="flex-row items-center gap-2 px-3 py-2">
        <SheetCloseButton
          accessibilityLabel="Close Mac screen"
          onClose={() => navigation.goBack()}
        />
        <AppText className="flex-1 font-t3-medium text-base">Mac screen</AppText>
        <AppText className="text-sm text-foreground-muted">View only</AppText>
      </View>
      {focused && foreground && allowed ? (
        <HostScreenViewer
          key={`${environmentId}:${attempt}`}
          environmentId={environmentId}
          onRetry={() => setAttempt((value) => value + 1)}
        />
      ) : (
        <View className="flex-1 items-center justify-center px-6">
          <AppText className="text-center text-foreground-muted">
            {allowed
              ? "Screen viewing paused"
              : "Screen viewing requires terminal access to this environment."}
          </AppText>
        </View>
      )}
    </View>
  );
}

function HostScreenViewer({
  environmentId,
  onRetry,
}: {
  readonly environmentId: EnvironmentId;
  readonly onRetry: () => void;
}) {
  const capture = useAtomCommand(serverEnvironment.captureHostScreen, { reportFailure: false });
  const [frame, setFrame] = useState<HostScreenFrame | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const captureFrame = useEffectEvent(async (target: EnvironmentId) =>
    capture({ environmentId: target, input: {} }),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- captures from the remote Mac only while mounted and running, cancelling refresh timers on pause or close
  useEffect(() => {
    if (paused) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const next = async () => {
      const result = await captureFrame(environmentId);
      if (stopped) return;
      if (result._tag === "Success") {
        setFrame(result.value);
        setError(null);
        timer = setTimeout(() => void next(), 1000);
      } else {
        const failure = Cause.squash(result.cause);
        if (isHostScreenError(failure) && failure.reason === "busy") {
          timer = setTimeout(() => void next(), 1000);
          return;
        }
        setError(String(failure));
        setFrame(null);
      }
    };
    void next();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [environmentId, paused]);
  return (
    <>
      <View className="flex-1 bg-black">
        {frame ? (
          <Image
            accessibilityLabel={paused ? "Paused Mac screen" : "Live Mac screen"}
            source={{ uri: `data:image/jpeg;base64,${frame.jpegBase64}` }}
            resizeMode="contain"
            style={{ flex: 1 }}
          />
        ) : (
          <View className="flex-1 items-center justify-center gap-4 px-6">
            <AppText className="text-center text-white">
              {error ?? "Connecting to Mac screen…"}
            </AppText>
            {error ? <Button label="Retry" tone="secondary" onPress={onRetry} /> : null}
          </View>
        )}
      </View>
      <View className="flex-row items-center justify-between gap-3 px-4 py-3">
        <AppText className="flex-1 text-sm text-foreground-muted">
          {error
            ? "Disconnected"
            : paused
              ? "Paused"
              : frame
                ? "Live · refreshes every second"
                : "Connecting…"}
        </AppText>
        <ControlPill
          label={paused ? "Resume" : "Pause"}
          accessibilityLabel={paused ? "Resume screen viewing" : "Pause screen viewing"}
          icon={paused ? "play" : "pause"}
          variant="pill"
          onPress={() => setPaused((value) => !value)}
        />
      </View>
    </>
  );
}
