import { AuthAccessWriteScope, type AuthPairingLink, type EnvironmentId } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef } from "react";

import * as Dialog from "../../components/ui/Dialog";
import { authEnvironment } from "../../state/auth";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { connectDeviceApprovalPrompts } from "./connectDeviceApproval";

/** Asks to approve T3 Connect devices waiting on hosts that require it and this phone manages. */
export function ConnectDeviceApprovalCoordinator() {
  const { environments } = useEnvironments();
  const requiring = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" &&
      environment.serverConfig?.settings.requireConnectDeviceApproval === true,
  );
  const managed = useEnvironmentsWithScope(requiring, AuthAccessWriteScope);
  return (
    <>
      {requiring
        .filter((environment) => managed.has(environment.environmentId))
        .map((environment) => (
          <EnvironmentApprovalWatcher
            key={environment.environmentId}
            environmentId={environment.environmentId}
            environmentLabel={environment.label}
          />
        ))}
    </>
  );
}

function EnvironmentApprovalWatcher(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
}) {
  const access = useEnvironmentQuery(
    authEnvironment.accessChanges({ environmentId: props.environmentId, input: null }),
  );
  const approve = useAtomCommand(authEnvironment.approveConnectDevice);
  const deny = useAtomCommand(authEnvironment.revokePairingLink);
  const shownIds = useRef(new Set<string>());
  const pairingLinks =
    access.data?.type === "snapshot" ? access.data.payload.pairingLinks : undefined;

  const showPrompts = useEffectEvent((links: ReadonlyArray<AuthPairingLink>) => {
    const prompts = connectDeviceApprovalPrompts({
      environmentLabel: props.environmentLabel,
      pairingLinks: links,
      shownIds: shownIds.current,
    });
    for (const prompt of prompts) {
      shownIds.current.add(prompt.pairingLinkId);
      Dialog.alert(prompt.title, prompt.message, [
        {
          text: "Deny",
          onPress: () =>
            void deny({ environmentId: props.environmentId, input: { id: prompt.pairingLinkId } }),
        },
        {
          text: "Approve",
          onPress: () =>
            void approve({
              environmentId: props.environmentId,
              input: { pairingLinkId: prompt.pairingLinkId },
            }),
        },
      ]);
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a new request on the access stream opens a native alert
  useEffect(() => {
    if (pairingLinks !== undefined) showPrompts(pairingLinks);
  }, [pairingLinks]);

  return null;
}
