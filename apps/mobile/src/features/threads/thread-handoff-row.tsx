import * as Dialog from "../../components/ui/Dialog";
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  resolveHandoffEndpoints,
  resolveModelSwitchChange,
  type HandoffEndpoints,
} from "@t3tools/client-runtime/handoff";
import { resolveModelShortName } from "@t3tools/client-runtime/provider-clients";
import {
  normalizeProviderAccentColor,
  resolveProviderInstanceDisplayName,
  shouldShowInstanceBadge,
} from "@t3tools/client-runtime/state/provider-instance-display";
import type {
  EnvironmentId,
  ModelSelection,
  OrchestrationV2ModelSwitch,
  OrchestrationV2ProjectedTurnItem,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";
import { Pressable, View, type ColorValue } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { ProviderIcon, ProviderInstanceIcon } from "../../components/ProviderIcon";
import { environmentThreadDetails } from "../../state/threads";
import { serverEnvironment } from "../../state/server";
import { ThreadContextDivider } from "./thread-context-divider";

type HandoffProvider = ServerProvider & {
  readonly driverKind: ServerProvider["driver"];
  readonly acpRegistryAgentId: string | undefined;
};

function handoffEndpointsAtom(
  environmentId: EnvironmentId,
  { item, sourceThreadId }: OrchestrationV2ProjectedTurnItem,
) {
  let previous: ReturnType<typeof resolveHandoffEndpoints> | null = null;
  const ref = scopeThreadRef(environmentId, sourceThreadId);
  return Atom.make((get) => {
    if (item.type !== "handoff") return null;
    const projection = get(environmentThreadDetails.threadAtom(ref))?.projection;
    const next = resolveHandoffEndpoints(item, projection?.runs ?? []);
    // Run activity changes frequently; only endpoint changes affect this row.
    if (JSON.stringify(next) !== JSON.stringify(previous)) previous = next;
    return previous;
  });
}

/** A same-harness model or effort change. Shows only what changed. */
export function ThreadModelSwitchDivider(props: {
  environmentId: EnvironmentId;
  modelSwitch: OrchestrationV2ModelSwitch;
  iconColor: ColorValue;
}) {
  const providers = useAtomValue(serverEnvironment.providersValueAtom(props.environmentId)) ?? [];
  const change = resolveModelSwitchChange(props.modelSwitch, providers);
  if (change === null) return null;
  const describe = (selection: ModelSelection, effort: string | undefined) => {
    const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
    const model = provider?.models.find((candidate) => candidate.slug === selection.model);
    const modelName =
      (model ? resolveModelShortName(model, provider?.driver) : undefined) ??
      model?.name ??
      selection.model;
    return [change.modelChanged ? modelName : null, effort].filter(Boolean).join(" ");
  };
  const { from, to } = props.modelSwitch;
  return (
    <ThreadContextDivider
      label={`${describe(from, change.effort?.from)} → ${describe(to, change.effort?.to)}`}
      iconColor={props.iconColor}
    />
  );
}

export function ThreadHandoffRow(props: {
  environmentId: EnvironmentId;
  projectedItem: OrchestrationV2ProjectedTurnItem;
  iconColor: ColorValue;
  surfaceColor: string;
}) {
  const { item } = props.projectedItem;
  const endpointsAtom = useMemo(
    () => handoffEndpointsAtom(props.environmentId, props.projectedItem),
    [props.environmentId, props.projectedItem],
  );
  const endpoints = useAtomValue(endpointsAtom);
  if (item.type !== "handoff" || endpoints === null) return null;
  const color = item.status === "failed" ? "#e11d48" : props.iconColor;
  return (
    <ThreadHandoffDivider
      environmentId={props.environmentId}
      endpoints={endpoints}
      iconColor={color}
      surfaceColor={props.surfaceColor}
      label="Context handoff"
      failed={item.status === "failed"}
    />
  );
}

export function ThreadHandoffDivider(props: {
  environmentId: EnvironmentId;
  endpoints: HandoffEndpoints;
  iconColor: ColorValue;
  surfaceColor: string;
  label: string;
  failed?: boolean;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  const { endpoints } = props;
  const endpointProps = {
    providers: (config?.providers ?? []).map((provider) => {
      const rawConfig = config?.settings.providerInstances[provider.instanceId]?.config;
      const instanceConfig =
        rawConfig !== null && typeof rawConfig === "object"
          ? (rawConfig as Readonly<Record<string, unknown>>)
          : null;
      const agentId = instanceConfig?.source === "local" ? undefined : instanceConfig?.agentId;
      return {
        ...provider,
        driverKind: provider.driver,
        accentColor: normalizeProviderAccentColor(provider.accentColor),
        acpRegistryAgentId: typeof agentId === "string" ? agentId.trim() || undefined : undefined,
      };
    }),
    surfaceColor: props.surfaceColor,
  };
  return (
    <ThreadContextDivider
      label={props.label}
      icon="arrow.left.arrow.right"
      iconColor={props.iconColor}
      failed={props.failed}
    >
      <View className="flex-row flex-wrap items-center justify-center gap-1.5">
        {endpoints.from.map((endpoint, index) => (
          <View
            key={`${endpoint.instanceId}:${endpoint.model ?? ""}`}
            className="max-w-full flex-row items-center"
          >
            <HandoffEndpoint {...endpoint} {...endpointProps} />
            {index < endpoints.from.length - 1 ? (
              <Text accessible={false} className="text-xs text-foreground-muted">
                ,
              </Text>
            ) : null}
          </View>
        ))}
        {endpoints.from.length > 0 ? (
          <SymbolView name="arrow.right" size={12} tintColor={props.iconColor} />
        ) : null}
        <HandoffEndpoint {...endpoints.to} {...endpointProps} />
      </View>
    </ThreadContextDivider>
  );
}

function HandoffEndpoint(props: {
  instanceId: ProviderInstanceId;
  model?: string | undefined;
  providers: ReadonlyArray<HandoffProvider>;
  surfaceColor: string;
}) {
  const provider = props.providers.find((candidate) => candidate.instanceId === props.instanceId);
  const model = provider?.models.find((candidate) => candidate.slug === props.model);
  const label =
    (model ? resolveModelShortName(model, provider?.driver) : undefined) ??
    model?.name ??
    props.model ??
    (provider ? resolveProviderInstanceDisplayName(provider) : props.instanceId);
  const showBadge = provider !== undefined && shouldShowInstanceBadge(provider, props.providers);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint="Show provider account"
      className="min-h-6 max-w-full flex-row items-center justify-center gap-1.5"
      hitSlop={{ top: 8, bottom: 8 }}
      onPress={() =>
        Dialog.alert(
          label,
          provider ? resolveProviderInstanceDisplayName(provider) : props.instanceId,
        )
      }
    >
      {showBadge && provider !== undefined ? (
        <ProviderInstanceIcon
          provider={provider.driver}
          iconUrl={provider.iconUrl}
          icon={provider.icon}
          size={14}
          displayName={resolveProviderInstanceDisplayName(provider)}
          accentColor={provider.accentColor}
          showBadge
          surfaceColor={props.surfaceColor}
        />
      ) : (
        <ProviderIcon
          provider={provider?.driver ?? props.instanceId}
          iconUrl={provider?.iconUrl}
          icon={provider?.icon}
          size={12}
        />
      )}
      <Text numberOfLines={1} className="shrink text-xs text-foreground-muted">
        {label}
      </Text>
    </Pressable>
  );
}
