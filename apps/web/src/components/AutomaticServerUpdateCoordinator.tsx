import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { automaticServerUpdateDecision } from "@t3tools/client-runtime/state/server";
import * as Option from "effect/Option";
import { useEffect, useRef } from "react";

import { APP_VERSION } from "~/branding";
import { useEnvironments } from "~/state/environments";
import { environmentShell } from "~/state/shell";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

function EnvironmentAutomaticServerUpdate({
  connected,
  environmentId,
}: {
  readonly connected: boolean;
  readonly environmentId: EnvironmentId;
}) {
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const shell = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const updateState = useAtomValue(serverEnvironment.updateStateAtom(environmentId));
  const updateServer = useAtomCommand(serverEnvironment.updateServer, { reportFailure: false });
  const setAutomaticUpdatePending = useAtomCommand(serverEnvironment.setAutomaticUpdatePending, {
    reportFailure: false,
  });
  const attemptedTargetRef = useRef<string | null>(null);
  const decision = automaticServerUpdateDecision({
    enabled: connected && (serverConfig?.settings.automaticallyUpdateWhenIdle ?? false),
    selfUpdate: serverConfig?.environment.capabilities.serverSelfUpdate ?? null,
    clientVersion: APP_VERSION,
    serverVersion: serverConfig?.environment.serverVersion ?? "",
    shellStatus: shell.status,
    threads: Option.isSome(shell.snapshot) ? shell.snapshot.value.threads : [],
  });
  const decisionStatus = decision.status;
  const decisionReason = decision.status === "pending" ? decision.reason : null;
  const fromVersion = decision.status === "ineligible" ? null : decision.fromVersion;
  const targetVersion = decision.status === "ineligible" ? null : decision.targetVersion;

  useEffect(() => {
    if (decisionStatus !== "ready" || fromVersion === null || targetVersion === null) {
      attemptedTargetRef.current = null;
    }

    if (decisionStatus === "pending" && fromVersion !== null && targetVersion !== null) {
      const pendingMatches =
        updateState.status === "pending" &&
        updateState.reason === decisionReason &&
        updateState.fromVersion === fromVersion &&
        updateState.targetVersion === targetVersion;
      if (!pendingMatches) {
        void setAutomaticUpdatePending({
          environmentId,
          pending: {
            status: "pending",
            reason: decisionReason ?? "synchronizing",
            fromVersion,
            targetVersion,
          },
        });
      }
      return;
    }

    if (decisionStatus === "ineligible") {
      if (updateState.status === "pending") {
        void setAutomaticUpdatePending({ environmentId, pending: null });
      }
      return;
    }

    if (decisionStatus !== "ready" || fromVersion === null || targetVersion === null) {
      return;
    }

    const targetKey = `${fromVersion}->${targetVersion}`;
    if (updateState.status === "running") {
      attemptedTargetRef.current = targetKey;
      return;
    }
    if (
      updateState.status === "failed" &&
      updateState.fromVersion === fromVersion &&
      updateState.targetVersion === targetVersion
    ) {
      attemptedTargetRef.current = targetKey;
      return;
    }
    if (attemptedTargetRef.current === targetKey) {
      return;
    }

    attemptedTargetRef.current = targetKey;
    void updateServer({
      environmentId,
      input: { targetVersion, automatic: true },
    });
  }, [
    decisionReason,
    decisionStatus,
    environmentId,
    fromVersion,
    setAutomaticUpdatePending,
    targetVersion,
    updateServer,
    updateState,
  ]);

  return null;
}

export function AutomaticServerUpdateCoordinator() {
  const { environments } = useEnvironments();

  return environments.map((environment) => (
    <EnvironmentAutomaticServerUpdate
      key={environment.environmentId}
      connected={environment.connection.phase === "connected"}
      environmentId={environment.environmentId}
    />
  ));
}
