import { AuthAccessWriteScope, type AuthPairingLink, type EnvironmentId } from "@t3tools/contracts";
import { useEffect, useEffectEvent } from "react";

import * as Dialog from "../../components/ui/Dialog";
import { authEnvironment } from "../../state/auth";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  type ConnectDeviceApprovalPrompt,
  connectDeviceApprovalPrompts,
  createApprovalPromptQueue,
} from "./connectDeviceApproval";

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

interface QueuedApprovalPrompt extends ConnectDeviceApprovalPrompt {
  readonly approve: () => Promise<boolean>;
  readonly deny: () => Promise<boolean>;
}

// One queue for every host: a second Android alert would replace an unanswered first one.
const approvalPrompts = createApprovalPromptQueue<QueuedApprovalPrompt>((prompt, answer) => {
  const respond = (action: () => Promise<boolean>, failure: string) => () =>
    void action().then((ok) => {
      if (ok) return answer("done");
      Dialog.alert(failure, "The request is still waiting. Try again.", [
        { text: "OK", onPress: () => answer("retry") },
      ]);
    });
  Dialog.alert(
    prompt.title,
    prompt.message,
    [
      { text: "Deny", onPress: respond(prompt.deny, "Could not deny the device") },
      { text: "Approve", onPress: respond(prompt.approve, "Could not approve the device") },
    ],
    { cancelable: false },
  );
});

function EnvironmentApprovalWatcher(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
}) {
  const access = useEnvironmentQuery(
    authEnvironment.accessChanges({ environmentId: props.environmentId, input: null }),
  );
  const approve = useAtomCommand(authEnvironment.approveConnectDevice, { reportFailure: false });
  const deny = useAtomCommand(authEnvironment.revokePairingLink, { reportFailure: false });
  const pairingLinks =
    access.data?.type === "snapshot" ? access.data.payload.pairingLinks : undefined;

  const offerPrompts = useEffectEvent((links: ReadonlyArray<AuthPairingLink>) => {
    const prompts = connectDeviceApprovalPrompts({
      environmentLabel: props.environmentLabel,
      pairingLinks: links,
      shownIds: approvalPrompts.known,
    });
    approvalPrompts.offer(
      prompts.map((prompt) => ({
        ...prompt,
        approve: () =>
          approve({
            environmentId: props.environmentId,
            input: { pairingLinkId: prompt.pairingLinkId },
          }).then((result) => result._tag === "Success"),
        deny: () =>
          deny({ environmentId: props.environmentId, input: { id: prompt.pairingLinkId } }).then(
            (result) => result._tag === "Success",
          ),
      })),
    );
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a new request on the access stream opens a native alert
  useEffect(() => {
    if (pairingLinks !== undefined) offerPrompts(pairingLinks);
  }, [pairingLinks]);

  return null;
}
