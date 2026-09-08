import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useIsFocused } from "@react-navigation/native";
import { getHostStoragePresentation } from "@t3tools/client-runtime/host-storage";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { Modal, Pressable, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { withUniwind } from "uniwind";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { serverEnvironment } from "../../state/server";

const ThemedSvg = withUniwind(Svg);

function HostStorageView(props: {
  readonly environmentLabel: string;
  readonly presentation: ReturnType<typeof getHostStoragePresentation>;
  readonly onRefresh?: () => void;
}) {
  const { presentation } = props;
  const loading = presentation.status === "loading";
  const [open, setOpen] = useState(false);
  const usedPercent =
    presentation.status === "available" ? 100 - presentation.availablePercent : null;

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${props.environmentLabel} disk space${presentation.status === "available" ? `: ${presentation.label}` : ""}`}
        accessibilityHint="Show disk capacity"
        onPress={() => setOpen(true)}
        className="h-11 w-11 items-center justify-center rounded-full active:bg-subtle"
      >
        <ThemedSvg
          width={20}
          height={20}
          viewBox="0 0 24 24"
          colorClassName="accent-foreground-muted"
        >
          <Circle
            cx={12}
            cy={12}
            r={9}
            fill="none"
            stroke="currentColor"
            strokeOpacity={0.2}
            strokeWidth={3}
          />
          {usedPercent !== null ? (
            <Circle
              cx={12}
              cy={12}
              r={9}
              fill="none"
              stroke="currentColor"
              strokeWidth={3}
              strokeDasharray={[(2 * Math.PI * 9 * usedPercent) / 100, 2 * Math.PI * 9]}
              rotation={-90}
              origin="12, 12"
            />
          ) : null}
        </ThemedSvg>
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable
          accessible={false}
          focusable={false}
          className="flex-1 items-center justify-center bg-backdrop px-8"
          onPress={() => setOpen(false)}
        >
          <Pressable
            accessible={false}
            focusable={false}
            accessibilityViewIsModal
            className="w-full max-w-sm gap-3 rounded-2xl bg-card p-4"
            onPress={(event) => event.stopPropagation()}
          >
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
              <Text className="text-2xs text-foreground-muted">
                {Math.round(100 - presentation.availablePercent)}% used or reserved{"\n"}
                Checked at {new Date(presentation.sampledAt).toLocaleTimeString()}
              </Text>
            ) : null}
            <Text className="text-xs text-foreground-muted">
              Other drives may have different space available.
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => setOpen(false)}
              className="min-h-11 items-center justify-center rounded-xl bg-subtle"
            >
              <Text className="text-sm text-foreground">Done</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </>
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
