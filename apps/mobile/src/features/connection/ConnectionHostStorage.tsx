import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useIsFocused } from "@react-navigation/native";
import { getHostStoragePresentation } from "@t3tools/client-runtime/host-storage";
import type { EnvironmentId } from "@t3tools/contracts";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { serverEnvironment } from "../../state/server";

function HostStorageView(props: {
  readonly environmentLabel: string;
  readonly presentation: ReturnType<typeof getHostStoragePresentation>;
  readonly onRefresh?: () => void;
}) {
  const { presentation } = props;
  const loading = presentation.status === "loading";

  return (
    <View className="gap-1.5 px-4 pb-3.5">
      <View className="flex-row items-center gap-2">
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="text-xs text-foreground-muted">Disk containing T3 data</Text>
          <Text className="text-xs text-foreground" selectable>
            {presentation.status === "available"
              ? presentation.label
              : loading
                ? "Checking storage…"
                : "Storage unavailable"}
          </Text>
        </View>
        {props.onRefresh ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Refresh disk storage for ${props.environmentLabel}`}
            accessibilityState={{ disabled: loading, busy: loading }}
            disabled={loading}
            onPress={props.onRefresh}
            className="h-11 w-11 items-center justify-center rounded-xl active:bg-subtle disabled:opacity-40"
          >
            <SymbolView
              name="arrow.clockwise"
              size={14}
              tintColorClassName="accent-icon-subtle"
              type="monochrome"
            />
          </Pressable>
        ) : null}
      </View>
      {presentation.status === "available" ? (
        <>
          <View
            accessible
            accessibilityRole="progressbar"
            accessibilityLabel="Available disk storage"
            accessibilityValue={{ min: 0, max: 100, now: presentation.availablePercent }}
            className="h-1 overflow-hidden rounded-full bg-subtle"
          >
            <View
              className="h-full rounded-full bg-primary"
              style={{ width: `${presentation.availablePercent}%` }}
            />
          </View>
          <Text className="text-2xs text-foreground-muted">
            Checked at {new Date(presentation.sampledAt).toLocaleTimeString()}
          </Text>
        </>
      ) : null}
    </View>
  );
}

function ConnectedHostStorage(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
}) {
  const query = serverEnvironment.hostResources({ environmentId: props.environmentId, input: {} });
  const result = useAtomValue(query);
  const refresh = useAtomRefresh(query);

  return (
    <HostStorageView
      environmentLabel={props.environmentLabel}
      presentation={getHostStoragePresentation(result)}
      onRefresh={refresh}
    />
  );
}

export function ConnectionHostStorage(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly connected: boolean;
}) {
  const isFocused = useIsFocused();
  if (!isFocused) return null;

  return props.connected ? (
    <ConnectedHostStorage
      environmentId={props.environmentId}
      environmentLabel={props.environmentLabel}
    />
  ) : (
    <HostStorageView
      environmentLabel={props.environmentLabel}
      presentation={{ status: "unavailable" }}
    />
  );
}
