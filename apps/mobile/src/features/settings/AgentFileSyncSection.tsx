import { useAtomValue } from "@effect/atom-react";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { appAtomRegistry } from "../../state/atom-registry";
import { agentFileSync } from "../../state/agentFileSync";
import { useEnvironmentQuery } from "../../state/query";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsSection } from "./components/SettingsSection";

const syncErrorMessage = (cause: unknown) =>
  cause instanceof Error ? cause.message : "Could not update sync.";

export function AgentFileSyncSection({ environmentId }: { environmentId: EnvironmentId }) {
  const links = useEnvironmentQuery(agentFileSync.links({ environmentId, input: {} }));
  const allowed = useAtomValue(agentFileSync.manage.permissionAtom(environmentId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const timer = setInterval(links.refresh, 15_000);
    return () => clearInterval(timer);
  }, [links.refresh]);
  const manage = async (id: string, action: "pause" | "resume" | "remove") => {
    setBusy(true);
    setError(null);
    try {
      const result = await runAtomCommand(
        appAtomRegistry,
        agentFileSync.manage,
        { environmentId, input: { id, action } },
        { reportFailure: false },
      );
      if (result._tag === "Failure") {
        setError(syncErrorMessage(squashAtomCommandFailure(result)));
      }
      links.refresh();
    } catch (cause) {
      setError(syncErrorMessage(cause));
    }
    setBusy(false);
  };
  return (
    <SettingsSection
      title="Skills & instructions"
      footer="Choose skills and instruction sections in web or desktop Settings. Sync continues while a T3 client connects both machines. Stopping sync keeps the current files."
    >
      {(links.data ?? []).map((link) => (
        <View key={link.id}>
          <View className="gap-1 p-4">
            <Text>
              From {link.label} · {link.paused ? "Paused" : "Automatic"}
            </Text>
            <Text className="text-sm text-foreground-muted">
              {link.scope.cwd ?? "Personal files"}
            </Text>
            {link.error ? (
              <Text className="text-sm text-danger-foreground">{link.error}</Text>
            ) : null}
          </View>
          <SettingsActionRow
            label={link.paused ? "Resume sync" : "Pause sync"}
            disabled={busy || !allowed}
            onPress={() => void manage(link.id, link.paused ? "resume" : "pause")}
          />
          <SettingsActionRow
            label="Stop sync"
            disabled={busy || !allowed}
            onPress={() => void manage(link.id, "remove")}
          />
        </View>
      ))}
      {!links.data?.length ? (
        <View className="p-4">
          <Text className="text-sm text-foreground-muted">
            {links.error ?? "No automatic sync subscriptions."}
          </Text>
        </View>
      ) : null}
      {error ? (
        <View className="p-4">
          <Text className="text-sm text-danger-foreground">{error}</Text>
        </View>
      ) : null}
    </SettingsSection>
  );
}
