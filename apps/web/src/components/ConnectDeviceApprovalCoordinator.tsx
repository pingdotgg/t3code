import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { useNavigate } from "@tanstack/react-router";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AuthAccessWriteScope, type EnvironmentId } from "@t3tools/contracts";
import { unseenConnectDevices } from "@t3tools/client-runtime/connect-device-notices";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { useEffect, useRef, useState } from "react";
import { msg } from "gt-react";

import { readLocalStorageValue, writeLocalStorageValue } from "../hooks/useLocalStorage";
import { m } from "../i18n/messages";
import { authEnvironment } from "../state/auth";
import { useEnvironments } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { useEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import { describeConnectDeviceClient } from "./settings/ConnectionsSettings.logic";
import { toastManager } from "./ui/toast";
import { stackedThreadToast } from "./ui/toastHelpers";

/**
 * Asks whoever can approve to look at T3 Connect devices waiting on an environment, and tells
 * them about devices that got in without approval.
 */
export function ConnectDeviceApprovalCoordinator() {
  const { environments } = useEnvironments();
  return environments.map((environment) =>
    environment.connection.phase === "connected" && environment.serverConfig ? (
      <EnvironmentConnectDevices
        key={environment.environmentId}
        environmentId={environment.environmentId}
        environmentLabel={environment.label}
        approvalRequired={environment.serverConfig.settings.requireConnectDeviceApproval}
      />
    ) : null,
  );
}

function EnvironmentConnectDevices({
  approvalRequired,
  ...props
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly approvalRequired: boolean;
}) {
  const canApprove = useEnvironmentScope(props.environmentId, AuthAccessWriteScope);
  if (!canApprove) return null;
  return (
    <>
      {approvalRequired ? <ConnectDeviceRequestToasts {...props} /> : null}
      <NewConnectDeviceToast {...props} announce={!approvalRequired} />
    </>
  );
}

const CONNECT_DEVICES_SEEN_KEY = "t3code:connect-devices-seen-through";
const ConnectDevicesSeenThrough = Schema.Record(Schema.String, Schema.Number);

/** Devices approved by hand are already known, so only `announce` hosts that skip approval. */
function NewConnectDeviceToast({
  environmentId,
  environmentLabel,
  announce,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly announce: boolean;
}) {
  const navigate = useNavigate();
  const access = useEnvironmentQuery(authEnvironment.accessChanges({ environmentId, input: null }));
  // Older servers omit the list.
  const devices =
    access.data?.type === "snapshot" ? (access.data.payload.connectDevices ?? null) : null;
  const shown = useRef<{ toastId: string; renderedKey: string } | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opens, updates and closes an imperative toastManager toast to match devices this client has not announced
  useEffect(() => {
    if (devices === null) return;
    const seenThrough = readLocalStorageValue(
      CONNECT_DEVICES_SEEN_KEY,
      {},
      ConnectDevicesSeenThrough,
    )[environmentId];
    const { unseen, newest } = unseenConnectDevices(devices, seenThrough);
    const markSeen = () =>
      writeLocalStorageValue(
        CONNECT_DEVICES_SEEN_KEY,
        (current) => ({
          ...current,
          [environmentId]: Math.max(current[environmentId] ?? 0, newest),
        }),
        {},
        ConnectDevicesSeenThrough,
      );
    const close = () => {
      if (shown.current) toastManager.close(shown.current.toastId);
      shown.current = null;
    };
    if (!announce || unseen.length === 0) {
      close();
      if (seenThrough !== newest) markSeen();
      return;
    }
    const renderedKey = unseen.map((device) => device.proofKeyThumbprint).join(",");
    if (shown.current?.renderedKey === renderedKey) return;
    const [first] = unseen;
    const options = stackedThreadToast({
      type: "warning",
      title: m(msg("New device signed in to {environmentLabel}", { environmentLabel })),
      description:
        unseen.length === 1 && first
          ? m(
              msg("{device} connected through {product}. Not you? Review it.", {
                device: describeConnectDeviceClient(first),
                product: "T3 Connect",
              }),
            )
          : m(
              msg(
                "{count, plural, one {{count} device} other {{count} devices}} connected through {product}. Not you? Review them.",
                { count: unseen.length, product: "T3 Connect" },
              ),
            ),
      timeout: 0,
      actionProps: {
        children: m(msg("Review", { $context: "verb, opens the device in settings" })),
        onClick: () => {
          markSeen();
          close();
          void navigate({ to: "/settings/access", search: { machine: environmentId } });
        },
      },
      data: {
        hideCopyButton: true,
        onClose: () => {
          markSeen();
          // A dismissed toast is gone, so the next unseen device needs a new one.
          if (shown.current?.renderedKey === renderedKey) shown.current = null;
        },
      },
    });
    if (shown.current) {
      toastManager.update(shown.current.toastId, options);
      shown.current = { toastId: shown.current.toastId, renderedKey };
    } else {
      shown.current = { toastId: toastManager.add(options), renderedKey };
    }
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- closes this environment's imperative toast when it goes away
  useEffect(
    () => () => {
      if (shown.current) toastManager.close(shown.current.toastId);
    },
    [],
  );

  return null;
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
        description: thrownErrorMessage(error, m) ?? m(msg("An error occurred.")),
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
        title: m(msg("A device wants to connect to {environmentLabel}", { environmentLabel })),
        description: m(
          msg("{device}. Approve only if it shows code {code}.", {
            device,
            code: request.verificationCode,
          }),
        ),
        timeout: remainingMs,
        actionProps: {
          children: m(msg("Approve")),
          onClick: () => {
            close();
            void settle(
              id,
              reportFailure(m(msg("Could not approve the device")), () =>
                approve({ environmentId, input: { pairingLinkId: id } }),
              ),
            );
          },
        },
        data: {
          hideCopyButton: true,
          secondaryActionProps: {
            children: m(msg("Deny")),
            onClick: () => {
              close();
              void settle(
                id,
                reportFailure(m(msg("Could not deny the device")), () =>
                  deny({ environmentId, input: { id } }),
                ),
              );
            },
          },
          additionalActions: [
            {
              id: "review",
              props: {
                children: m(msg("Review", { $context: "verb, opens the device in settings" })),
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
