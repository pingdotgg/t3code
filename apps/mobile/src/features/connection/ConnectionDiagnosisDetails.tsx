import { useAtomValue } from "@effect/atom-react";
import {
  AVAILABLE_CONNECTION_STATE,
  type ConnectionDiagnosis,
  connectionDiagnosisText,
  connectionRoutes,
  environmentTailscaleNotice,
  hasRelayRoute,
  presentConnectionDiagnosis,
  type EnvironmentPresentation,
} from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import Constants from "expo-constants";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { Linking, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { environmentCatalog } from "../../connection/catalog";
import { cn } from "../../lib/cn";
import { useNowMinuteMs } from "../../lib/clock";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { relayEnvironmentDiscovery } from "../../state/relay";

const HOP_MARK = { ok: "✓", failed: "✕", unchecked: "–" } as const;
const HOP_NOTE = { ok: "", failed: " · Failed", unchecked: " · Not checked" } as const;

/** Same model as the web Settings row; null while connected, off, or not failed. */
export function useConnectionDiagnosis(
  environmentId: EnvironmentId,
  presentation: EnvironmentPresentation | null,
) {
  const state = AsyncResult.getOrElse(
    useAtomValue(environmentCatalog.stateAtom(environmentId)),
    () => AVAILABLE_CONNECTION_STATE,
  );
  const relayStatus = useAtomValue(relayEnvironmentDiscovery.stateValueAtom).environments.get(
    environmentId,
  )?.status;
  if (presentation === null || !presentation.entry.enabled) return { diagnosis: null, state };
  const phase = presentation.connection.phase;
  if (phase === "connected" || phase === "unsupported") return { diagnosis: null, state };
  const relayOnly =
    connectionRoutes(presentation.entry).length === 1 && hasRelayRoute(presentation.entry);
  const diagnosis = presentConnectionDiagnosis({
    hostLabel: presentation.entry.target.label,
    state,
    via: relayOnly ? "relay" : "direct",
    relayStatus: hasRelayRoute(presentation.entry)
      ? Option.getOrNull(relayStatus ?? Option.none())
      : null,
    clientVersion: Constants.expoConfig?.version,
    serverVersion: presentation.serverConfig?.environment.serverVersion,
    hostTailscale: presentation.serverConfig?.tailscale,
  });
  return { diagnosis, state };
}

/** The host's last reported Tailscale problem, for its row while no connection has failed. */
export function HostTailscaleNotice(props: { readonly presentation: EnvironmentPresentation }) {
  return props.presentation.serverConfig?.tailscale?.issues.length ? (
    <HostTailscaleNoticeLines presentation={props.presentation} />
  ) : null;
}

// Ticks once a minute, and only for hosts with a Tailscale issue, so ages and expiry stay current.
function HostTailscaleNoticeLines(props: { readonly presentation: EnvironmentPresentation }) {
  const now = useNowMinuteMs();
  const notice = environmentTailscaleNotice({
    hostLabel: props.presentation.entry.target.label,
    entry: props.presentation.entry,
    serverConfig: props.presentation.serverConfig,
    now,
  });
  if (notice === null) return null;
  return (
    <>
      <Text className="text-xs text-warning-foreground">{notice.headline}</Text>
      <Text className="text-xs text-foreground-muted">{notice.fix}</Text>
    </>
  );
}

export function ConnectionDiagnosisDetails(props: {
  readonly hostLabel: string;
  readonly diagnosis: ConnectionDiagnosis;
}) {
  const { diagnosis } = props;
  const { moreInfoUrl } = diagnosis;
  return (
    <View className="gap-3">
      <View className="gap-0.5">
        {diagnosis.hops.map((hop) => (
          <Text
            key={hop.hop}
            className={cn(
              "text-sm",
              hop.result === "failed" ? "text-danger-foreground" : "text-foreground-muted",
            )}
          >
            {`${HOP_MARK[hop.result]}  ${hop.label}${HOP_NOTE[hop.result]}`}
          </Text>
        ))}
      </View>
      <View className="gap-0.5">
        <Text className="text-sm font-t3-bold text-foreground">What to try</Text>
        {diagnosis.steps.map((step, index) => (
          <Text key={step} className="text-sm text-foreground-muted">
            {`${index + 1}. ${step}`}
          </Text>
        ))}
        {diagnosis.policySnippet ? (
          <Text selectable className="mt-1 font-mono text-xs text-foreground">
            {diagnosis.policySnippet}
          </Text>
        ) : null}
      </View>
      <Text selectable className="font-mono text-xs text-foreground-muted">
        {diagnosis.facts.map(([label, value]) => `${label}: ${value}`).join("\n")}
      </Text>
      <Button
        label="Copy diagnostics"
        icon="doc.on.doc"
        onPress={() => {
          copyTextWithHaptic(connectionDiagnosisText(props.hostLabel, diagnosis), {
            target: "connection-diagnostics",
          });
        }}
      />
      {moreInfoUrl ? (
        <Button
          label="More info"
          icon="safari"
          tone="secondary"
          onPress={() => void Linking.openURL(moreInfoUrl).catch(() => undefined)}
        />
      ) : null}
    </View>
  );
}
