import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { resolveHandoffEndpoints } from "@t3tools/client-runtime/handoff";
import {
  normalizeProviderAccentColor,
  resolveProviderInstanceDisplayName,
  shouldShowInstanceBadge,
} from "@t3tools/client-runtime/state/provider-instance-display";
import type {
  EnvironmentId,
  ProviderInstanceConfig,
  OrchestrationV2ProjectedTurnItem,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { Fragment, useMemo } from "react";
import { Alert, Pressable, View, type ColorValue } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ProviderIcon, ProviderInstanceIcon } from "../../components/ProviderIcon";
import { environmentThreadDetails } from "../../state/threads";
import { serverEnvironment } from "../../state/server";
import { ThreadContextDivider } from "./thread-context-divider";

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
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  if (item.type !== "handoff" || endpoints === null) return null;
  const color = item.status === "failed" ? "#e11d48" : props.iconColor;
  const endpointProps = {
    providers: config?.providers ?? [],
    providerInstances: config?.settings.providerInstances,
    surfaceColor: props.surfaceColor,
  };
  return (
    <ThreadContextDivider
      label="Context handoff"
      icon="arrow.left.arrow.right"
      iconColor={color}
      failed={item.status === "failed"}
    >
      <View className="flex-row flex-wrap items-center justify-center gap-1.5">
        {endpoints.from.map((endpoint, index) => (
          <Fragment key={`${endpoint.instanceId}:${endpoint.model ?? ""}`}>
            {index > 0 ? (
              <Text accessible={false} className="text-xs text-foreground-muted">
                ,
              </Text>
            ) : null}
            <HandoffEndpoint {...endpoint} {...endpointProps} />
          </Fragment>
        ))}
        {endpoints.from.length > 0 ? (
          <SymbolView name="arrow.right" size={12} tintColor={color} />
        ) : null}
        <HandoffEndpoint {...endpoints.to} {...endpointProps} />
      </View>
    </ThreadContextDivider>
  );
}

function HandoffEndpoint(props: {
  instanceId: ProviderInstanceId;
  model?: string | undefined;
  providers: ReadonlyArray<ServerProvider>;
  providerInstances: Readonly<Record<string, ProviderInstanceConfig>> | undefined;
  surfaceColor: string;
}) {
  const provider = props.providers.find((candidate) => candidate.instanceId === props.instanceId);
  const model = provider?.models.find((candidate) => candidate.slug === props.model);
  const label =
    model?.shortName ??
    model?.name ??
    props.model ??
    (provider ? resolveProviderInstanceDisplayName(provider) : props.instanceId);
  const accentColor = normalizeProviderAccentColor(provider?.accentColor);
  // Same account badge as the thread rows: a handoff between two accounts of
  // one provider would otherwise show the same glyph on both sides. Settings
  // carry each ACP instance's agent, which tells its glyph apart.
  const badgeEntry = (candidate: ServerProvider) => {
    const config = props.providerInstances?.[candidate.instanceId]?.config;
    const agentId = typeof config === "object" && config ? Reflect.get(config, "agentId") : null;
    return {
      driverKind: candidate.driver,
      ...(typeof agentId === "string" ? { acpRegistryAgentId: agentId.trim() } : {}),
    };
  };
  const showBadge =
    provider !== undefined &&
    shouldShowInstanceBadge(
      { ...badgeEntry(provider), accentColor },
      props.providers.map(badgeEntry),
    );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint="Show provider account"
      className="min-h-6 max-w-full flex-row items-center justify-center gap-1.5"
      hitSlop={{ top: 8, bottom: 8 }}
      onPress={() =>
        Alert.alert(
          label,
          provider ? resolveProviderInstanceDisplayName(provider) : props.instanceId,
        )
      }
    >
      {showBadge && provider !== undefined ? (
        <ProviderInstanceIcon
          provider={provider.driver}
          iconUrl={provider.iconUrl}
          size={14}
          displayName={resolveProviderInstanceDisplayName(provider)}
          accentColor={accentColor}
          showBadge
          surfaceColor={props.surfaceColor}
        />
      ) : (
        <ProviderIcon
          provider={provider?.driver ?? props.instanceId}
          iconUrl={provider?.iconUrl}
          size={12}
        />
      )}
      <Text numberOfLines={1} className="shrink text-xs text-foreground-muted">
        {label}
      </Text>
    </Pressable>
  );
}
