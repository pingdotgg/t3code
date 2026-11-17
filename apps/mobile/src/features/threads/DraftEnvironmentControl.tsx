import { Pressable } from "react-native";
import type { EnvironmentMachineKind } from "@t3tools/contracts";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { BoatIcon } from "../../components/BoatIcon";
import { BoxdIcon } from "../../components/BoxdIcon";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";

import { ConnectionStatusDot } from "../connection/ConnectionStatusDot";

export function DraftEnvironmentControl(props: {
  readonly label: string;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly machineKind: EnvironmentMachineKind;
  readonly boatCloud: boolean;
  readonly boxdCloud: boolean;
  readonly disabled: boolean;
  readonly onChooseEnvironment: () => void;
}) {
  const disconnected = props.connectionState !== "connected";
  const label = props.boxdCloud ? "boxd cloud" : props.boatCloud ? "Boat cloud" : props.label;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Choose environment, ${label}, ${disconnected ? "Offline" : "Connected"}`}
      disabled={props.disabled}
      onPress={props.onChooseEnvironment}
      className="flex-row items-center gap-1.5 rounded-xl px-3 py-2 active:opacity-65"
    >
      {props.boxdCloud ? (
        <BoxdIcon size={13} colorClassName="accent-icon-muted" />
      ) : props.boatCloud ? (
        <BoatIcon size={13} colorClassName="accent-icon-muted" />
      ) : (
        <EnvironmentMachineSymbol
          kind={props.machineKind}
          size={13}
          tintColorClassName="accent-icon-muted"
        />
      )}
      <Text className="shrink text-sm text-foreground-muted" numberOfLines={1}>
        on {label}
      </Text>
      <SymbolView name="chevron.right" size={11} tintColorClassName="accent-icon-muted" />
      {disconnected ? <ConnectionStatusDot state="error" pulse={false} size={6} /> : null}
    </Pressable>
  );
}
