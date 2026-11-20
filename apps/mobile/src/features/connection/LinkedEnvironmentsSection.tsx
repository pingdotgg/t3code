import { useGT } from "gt-react-native";
import { offersLinkedEnvironments } from "@t3tools/client-runtime/link-request";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { peerLinkHealth } from "@t3tools/client-runtime/state/peerLinks";
import { useFocusEffect } from "@react-navigation/native";
import { AuthAccessReadScope, type EnvironmentId, type PeerLinkSummary } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { useCallback, useContext, useState } from "react";
import { AppState, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { useEnvironmentServerConfig } from "../../state/entities";
import { peerLinkEnvironment } from "../../state/peerLinks";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "../settings/components/SettingsSection";

export function LinkedEnvironmentsSection(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
}) {
  const gt = useGT();
  const config = useEnvironmentServerConfig(props.environmentId);
  const canRead = useEnvironmentScope(props.environmentId, AuthAccessReadScope);
  const supported = canRead && offersLinkedEnvironments(config);
  const listAtom = supported
    ? peerLinkEnvironment.list({ environmentId: props.environmentId, input: {} })
    : null;
  const links = useEnvironmentQuery(listAtom);
  const registry = useContext(RegistryContext);
  // Links change outside this client, and the shared list only revalidates when built, so
  // showing the screen and bringing the app back ask again.
  useFocusEffect(
    useCallback(() => {
      if (listAtom === null) return;
      const askAgain = () => {
        if (!registry.get(listAtom).waiting) registry.refresh(listAtom);
      };
      askAgain();
      const subscription = AppState.addEventListener("change", (state) => {
        if (state === "active") askAgain();
      });
      return () => subscription.remove();
    }, [listAtom, registry]),
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
  if (!supported || (!links.error && (!links.data || links.data.links.length === 0))) return null;
  const now = DateTime.makeUnsafe(nowMs);
  return (
    <View className="mt-5 gap-3">
      <SettingsSection
        title={gt("Linked from {environment}", { environment: props.environmentLabel })}
      >
        {links.error ? (
          <View className="gap-3 p-4">
            <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
              {links.error}
            </Text>
            <Button label={gt("Retry linked environments")} tone="text" onPress={links.refresh} />
          </View>
        ) : null}
        {links.data?.links.map((link) => {
          const health = peerLinkHealth(link, now);
          const status =
            health.kind === "expired"
              ? gt("Expired. Link it again with a new pairing code.")
              : health.kind === "unreachable"
                ? (health.detail ?? gt("Not answering right now."))
                : health.kind === "failing"
                  ? health.detail
                  : health.expiresInDays !== null
                    ? gt(
                        "{count, plural, one {Expires in {count} day} other {Expires in {count} days}}",
                        { count: health.expiresInDays },
                      )
                    : gt("Reachable");
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
              <ForgetEnvironmentLink environmentId={props.environmentId} link={link} />
            </View>
          );
        })}
      </SettingsSection>
    </View>
  );
}

function ForgetEnvironmentLink(props: {
  readonly environmentId: EnvironmentId;
  readonly link: PeerLinkSummary;
}) {
  const gt = useGT();
  const canUnlink = useAtomValue(peerLinkEnvironment.unlink.permissionAtom(props.environmentId));
  const unlink = useAtomCommand(peerLinkEnvironment.unlink, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  if (!canUnlink) return null;
  const forget = async () => {
    if (busy) return;
    setBusy(true);
    const result = await unlink({
      environmentId: props.environmentId,
      input: { environmentId: props.link.environmentId },
    }).finally(() => setBusy(false));
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      Dialog.alert(
        gt("Could not forget the link"),
        error instanceof Error ? error.message : String(error),
      );
    }
  };
  return (
    <Button
      label={busy ? gt("Forgetting…") : gt("Forget link")}
      accessibilityLabel={gt("Forget link to {environment}", { environment: props.link.label })}
      tone="text"
      disabled={busy}
      onPress={() =>
        Dialog.confirm({
          title: gt("Forget {environment}?", { environment: props.link.label }),
          message: gt(
            'Agents here stop working there. Revoke "T3 Code · …" in {environment}’s Connections to end the session there too.',
            { environment: props.link.label },
          ),
          confirmText: gt("Forget"),
          destructive: true,
          onConfirm: () => void forget(),
        })
      }
    />
  );
}
