import { peerLinkHealth } from "@t3tools/client-runtime/state/peerLinks";
import { useFocusEffect } from "@react-navigation/native";
import { AuthAccessReadScope, type EnvironmentId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { useCallback, useState } from "react";
import { AppState, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { useEnvironmentServerConfig } from "../../state/entities";
import { peerLinkEnvironment } from "../../state/peerLinks";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { SettingsSection } from "../settings/components/SettingsSection";

export function LinkedEnvironmentsSection(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
}) {
  const config = useEnvironmentServerConfig(props.environmentId);
  const canRead = useEnvironmentScope(props.environmentId, AuthAccessReadScope);
  const supported = canRead && config?.environment.capabilities.peerLinks === true;
  const links = useEnvironmentQuery(
    supported ? peerLinkEnvironment.list({ environmentId: props.environmentId, input: {} }) : null,
  );
  const [nowMs, setNowMs] = useState(Date.now);
  const hasLinks = supported && (links.data?.links.length ?? 0) > 0;
  useFocusEffect(
    useCallback(() => {
      if (!hasLinks) return;
      const updateNow = () => setNowMs(Date.now());
      updateNow();
      const timer = setInterval(updateNow, 60_000);
      const subscription = AppState.addEventListener("change", (state) => {
        if (state === "active") updateNow();
      });
      return () => {
        clearInterval(timer);
        subscription.remove();
      };
    }, [hasLinks]),
  );
  if (!supported || links.error || !links.data || links.data.links.length === 0) return null;
  const now = DateTime.makeUnsafe(nowMs);
  return (
    <View className="mt-5 gap-3">
      <SettingsSection title={`Linked from ${props.environmentLabel}`}>
        {links.data.links.map((link) => {
          const health = peerLinkHealth(link, now);
          const status =
            health.kind === "expired"
              ? "Expired. Link it again with a new pairing code."
              : health.kind === "unreachable"
                ? (health.detail ?? "Not answering right now.")
                : health.kind === "failing"
                  ? health.detail
                  : health.expiresInDays !== null
                    ? `Expires in ${health.expiresInDays} ${health.expiresInDays === 1 ? "day" : "days"}`
                    : "Reachable";
          return (
            <View key={link.environmentId} className="gap-0.5 p-4">
              <Text className="text-base font-t3-bold text-foreground">{link.label}</Text>
              <Text
                className={
                  health.kind === "reachable" && health.expiresInDays === null
                    ? "text-xs text-foreground-muted"
                    : "text-xs text-danger-foreground"
                }
                numberOfLines={2}
              >
                {status}
              </Text>
            </View>
          );
        })}
      </SettingsSection>
    </View>
  );
}
