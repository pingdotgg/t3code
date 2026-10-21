import { useAtomValue } from "@effect/atom-react";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import {
  describeOutdatedServer,
  serverEnvironment,
  updateOutdatedServer,
} from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsSection } from "./components/SettingsSection";
import { findEnvironmentUpdate } from "./environment-maintenance";

export function OutdatedServerUpdateSection({
  environmentId,
  label,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  const describe = useAtomCommand(describeOutdatedServer, { reportFailure: false });
  const update = useAtomCommand(updateOutdatedServer, { reportFailure: false });
  const state = useAtomValue(serverEnvironment.updateStateAtom(environmentId));
  const [release, setRelease] = useState<{
    fromVersion: string;
    targetVersion: string | null;
  } | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const busy = checking || state.status === "running";

  async function check() {
    if (busy || controller.current !== null) return;
    const request = new AbortController();
    controller.current = request;
    setChecking(true);
    setError(null);
    const timeout = setTimeout(() => request.abort(), 20_000);
    const result = await settlePromise(async () => {
      const description = await describe(environmentId);
      if (AsyncResult.isFailure(description)) throw squashAtomCommandFailure(description);
      const fromVersion = description.value.serverVersion;
      const targetVersion = await findEnvironmentUpdate(fromVersion, request.signal);
      if (!request.signal.aborted) setRelease({ fromVersion, targetVersion });
    });
    clearTimeout(timeout);
    controller.current = null;
    setChecking(false);
    if (AsyncResult.isFailure(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Could not check for updates.");
    }
  }

  function requestUpdate() {
    const targetVersion = release?.targetVersion;
    if (busy || !release || !targetVersion) return;
    Dialog.alert(
      `Update ${label}?`,
      `Install T3 Code ${targetVersion}. T3 Code restarts on that machine and reconnects. Running threads may be interrupted.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Update",
          onPress: () => {
            setError(null);
            void update({
              environmentId,
              input: { targetVersion },
              fromVersion: release.fromVersion,
            });
          },
        },
      ],
    );
  }

  return (
    <SettingsSection title="T3 Code">
      <View className="gap-1 p-4">
        <Text className="text-base text-foreground">
          {release ? `Version ${release.fromVersion}` : "Update required"}
        </Text>
        <Text className="text-sm text-foreground-muted">
          {state.status === "running"
            ? state.stage === "resuming"
              ? "Restarting and reconnecting…"
              : state.stage === "installing"
                ? "Installing update…"
                : "Downloading update…"
            : release
              ? release.targetVersion
                ? `Version ${release.targetVersion} is available.`
                : "No newer version is available yet."
              : "This app needs a newer version of T3 Code on this machine."}
        </Text>
        {error || state.status === "failed" ? (
          <Text selectable accessibilityRole="alert" className="text-sm text-danger-foreground">
            {error ?? (state.status === "failed" ? state.message : null)}
          </Text>
        ) : null}
      </View>
      <SettingsActionRow
        icon="arrow.clockwise"
        label="Check for updates"
        disabled={busy}
        loading={checking}
        onPress={() => void check()}
      />
      {release?.targetVersion ? (
        <SettingsActionRow
          icon="arrow.up.circle"
          label={state.status === "failed" ? "Retry update" : `Update to ${release.targetVersion}`}
          disabled={busy}
          loading={state.status === "running"}
          onPress={requestUpdate}
        />
      ) : null}
    </SettingsSection>
  );
}
