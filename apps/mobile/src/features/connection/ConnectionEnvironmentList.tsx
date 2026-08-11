import type { EnvironmentId } from "@t3tools/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import type { ConnectedEnvironmentSummary } from "../../state/remote-runtime-types";
import {
  ConnectionEnvironmentRow,
  type ConnectionEnvironmentRowProps,
} from "./ConnectionEnvironmentRow";

type ConnectionEnvironmentListActions = Pick<
  ConnectionEnvironmentRowProps,
  "onReconnect" | "onSetEnabled" | "onRemove" | "onUpdate"
>;

export function ConnectionEnvironmentList(
  props: {
    readonly environments: ReadonlyArray<ConnectedEnvironmentSummary>;
    readonly expandedId: EnvironmentId | null;
    readonly onToggle: (environmentId: EnvironmentId) => void;
  } & ConnectionEnvironmentListActions,
) {
  const accentColor = useThemeColor("--color-icon-muted");

  if (props.environments.length === 0) {
    return (
      <View collapsable={false} className="items-center gap-3 rounded-[24px] bg-card px-6 py-8">
        <View className="h-12 w-12 items-center justify-center rounded-[16px] bg-subtle">
          <SymbolView
            name="point.3.connected.trianglepath.dotted"
            size={20}
            tintColor={accentColor}
            type="monochrome"
          />
        </View>
        <Text className="text-center text-sm leading-normal text-foreground-muted">
          No environments connected yet.{"\n"}Tap{" "}
          <Text className="font-t3-bold text-foreground">+</Text> to add one.
        </Text>
      </View>
    );
  }

  return (
    <View collapsable={false} className="overflow-hidden rounded-[24px] bg-card">
      {props.environments.map((environment, index) => (
        <View
          key={environment.environmentId}
          collapsable={false}
          className={cn(index !== 0 && "border-t border-border")}
        >
          <ConnectionEnvironmentRow
            environment={environment}
            expanded={props.expandedId === environment.environmentId}
            onToggle={() => props.onToggle(environment.environmentId)}
            onReconnect={props.onReconnect}
            onSetEnabled={props.onSetEnabled}
            onRemove={props.onRemove}
            onUpdate={props.onUpdate}
          />
        </View>
      ))}
    </View>
  );
}
