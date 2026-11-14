import { useNavigate } from "@tanstack/react-router";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AuthAccessWriteScope, type EnvironmentId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { useEffect, useRef, useState } from "react";

import { authEnvironment } from "../state/auth";
import { useEnvironments } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { useEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import { describeConnectDeviceClient } from "./settings/ConnectionsSettings.logic";
import { toastManager } from "./ui/toast";
import { stackedThreadToast } from "./ui/toastHelpers";

/** Asks whoever can approve to look at T3 Connect devices waiting on an environment. */
export function ConnectDeviceApprovalCoordinator() {
  const { environments } = useEnvironments();
  return environments.map((environment) =>
    environment.connection.phase === "connected" &&
    environment.serverConfig?.settings.requireConnectDeviceApproval === true ? (
      <EnvironmentConnectDeviceRequests
        key={environment.environmentId}
        environmentId={environment.environmentId}
        environmentLabel={environment.label}
      />
    ) : null,
  );
}

function EnvironmentConnectDeviceRequests(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
}) {
  const canApprove = useEnvironmentScope(props.environmentId, AuthAccessWriteScope);
  return canApprove ? <ConnectDeviceRequestToasts {...props} /> : null;
}

/** Reports a failed command and says whether it failed, so its request can be offered again. */
async function reportFailure(
  title: string,
  action: () => Promise<AtomCommandResult<unknown, unknown>>,
): Promise<boolean> {
  const result = await action();
  if (result._tag !== "Failure") return false;
  if (!isAtomCommandInterrupted(result)) {
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  }
  return true;
}

function ConnectDeviceRequestToasts({
  environmentId,
  environmentLabel,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
}) {
  const navigate = useNavigate();
  const access = useEnvironmentQuery(authEnvironment.accessChanges({ environmentId, input: null }));
  const approve = useAtomCommand(authEnvironment.approveConnectDevice, { reportFailure: false });
  const deny = useAtomCommand(authEnvironment.revokePairingLink, { reportFailure: false });
  const toasts = useRef(new Map<string, { toastId: string; renderedKey: string }>());
  const [, setRetryGeneration] = useState(0);
  // A failed approve or deny forgets its toast and re-renders, so the request is offered again.
  const settle = async (id: string, failed: Promise<boolean>) => {
    if (!(await failed)) return;
    toasts.current.delete(id);
    setRetryGeneration((generation) => generation + 1);
  };

  const requests =
    access.data?.type === "snapshot"
      ? access.data.payload.pairingLinks.flatMap((link) =>
          link.connectDeviceRequest
            ? [{ id: link.id, request: link.connectDeviceRequest, expiresAt: link.expiresAt }]
            : [],
        )
      : null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opens, updates and closes imperative toastManager toasts to match the pending requests
  useEffect(() => {
    if (requests === null) return;
    // The server publishes no event when a request expires, so the toast ends itself then.
    const now = Date.now();
    const live = requests.flatMap((entry) => {
      const remainingMs = DateTime.toEpochMillis(entry.expiresAt) - now;
      return remainingMs > 0 ? [{ ...entry, remainingMs }] : [];
    });
    const pendingIds = new Set(live.map(({ id }) => id));
    for (const [id, tracked] of toasts.current) {
      if (pendingIds.has(id)) continue;
      toastManager.close(tracked.toastId);
      toasts.current.delete(id);
    }
    for (const { id, request, remainingMs } of live) {
      const device = describeConnectDeviceClient(request);
      const renderedKey = `${request.verificationCode}:${device}`;
      const tracked = toasts.current.get(id);
      if (tracked?.renderedKey === renderedKey) continue;
      const close = () => {
        const current = toasts.current.get(id);
        if (current) toastManager.close(current.toastId);
      };
      const options = stackedThreadToast({
        type: "info",
        title: `A device wants to connect to ${environmentLabel}`,
        description: `${device}. Approve only if it shows code ${request.verificationCode}.`,
        timeout: remainingMs,
        actionProps: {
          children: "Approve",
          onClick: () => {
            close();
            void settle(
              id,
              reportFailure("Could not approve the device", () =>
                approve({ environmentId, input: { pairingLinkId: id } }),
              ),
            );
          },
        },
        data: {
          hideCopyButton: true,
          secondaryActionProps: {
            children: "Deny",
            onClick: () => {
              close();
              void settle(
                id,
                reportFailure("Could not deny the device", () =>
                  deny({ environmentId, input: { id } }),
                ),
              );
            },
          },
          additionalActions: [
            {
              id: "review",
              props: {
                children: "Review",
                onClick: () =>
                  void navigate({ to: "/settings/access", search: { machine: environmentId } }),
              },
            },
          ],
        },
      });
      if (tracked) {
        toastManager.update(tracked.toastId, options);
        toasts.current.set(id, { toastId: tracked.toastId, renderedKey });
      } else {
        toasts.current.set(id, { toastId: toastManager.add(options), renderedKey });
      }
    }
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- closes this environment's imperative toasts when it stops needing approval
  useEffect(() => {
    const tracked = toasts.current;
    return () => {
      for (const { toastId } of tracked.values()) toastManager.close(toastId);
      tracked.clear();
    };
  }, []);

  return null;
}
