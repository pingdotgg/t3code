import type { DesktopUpdateCommandRequest, DesktopUpdateState } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { useCheckProviderUpdates } from "../ProviderUpdatesAction";
import { downloadLocalUpdate, installLocalUpdate } from "../sidebar/SidebarUpdatePill";
import { useUpdateEverything } from "../sidebar/useUpdateEverything";
import { UpdateEverythingDialog } from "../sidebar/UpdateEverythingDialog";
import {
  getDesktopUpdateDownloadedVersion,
  resolveDesktopUpdateButtonAction,
} from "../desktopUpdate.logic";
import { stackedThreadToast, toastManager } from "../ui/toast";

// The document owns the runner; component remounts must not transfer its reservation.
const rendererId = SecureRandom.uuidV4Unsafe();

export function DesktopUpdateCoordinator() {
  const command = window.desktopBridge?.updateCommand;
  const latestRequestId = useRef<string | null>(null);
  const [request, setRequest] = useState<DesktopUpdateCommandRequest | null>(null);
  const [prepared, setPrepared] = useState<DesktopUpdateState | null>(null);
  const action = prepared?.enabled ? resolveDesktopUpdateButtonAction(prepared) : "none";
  const localVersion =
    prepared && action !== "none" ? getDesktopUpdateDownloadedVersion(prepared) : null;
  const everything = useUpdateEverything(localVersion);
  const checkProviderUpdates = useCheckProviderUpdates();
  const [checkingProviders, setCheckingProviders] = useState(false);

  const receive = useEffectEvent(async (incoming: DesktopUpdateCommandRequest) => {
    if (!command) return;
    const bridge = window.desktopBridge!;
    // The host serializes requests. A newer token supersedes a cancelled or expired confirmation.
    latestRequestId.current = incoming.requestId;
    setRequest(null);
    // Machines that still cache an older latest version add their rows while the dialog is open.
    setCheckingProviders(true);
    void checkProviderUpdates({ quiet: true }).finally(() => setCheckingProviders(false));
    let current = await bridge.getUpdateState();
    if (latestRequestId.current !== incoming.requestId) return;
    if (
      current.status === "idle" ||
      current.status === "up-to-date" ||
      current.status === "error"
    ) {
      current = (await bridge.checkForUpdate()).state;
    }
    if (latestRequestId.current !== incoming.requestId) return;
    if (current.status === "checking" || current.status === "downloading") {
      await command.complete({
        version: 1,
        requestId: incoming.requestId,
        ok: false,
        code: "internal-error",
        message: "An update check or download is already in progress.",
      });
      return;
    }
    const localAction = current.enabled ? resolveDesktopUpdateButtonAction(current) : "none";
    if (localAction === "none" && !everything.hasUpdates) {
      const reason = !current.enabled
        ? (current.message ?? "Desktop updates are disabled.")
        : current.status === "error"
          ? current.message
          : null;
      await command.complete(
        reason
          ? {
              version: 1,
              requestId: incoming.requestId,
              ok: false,
              code: "internal-error",
              message: reason,
            }
          : { version: 1, requestId: incoming.requestId, ok: true, status: "up-to-date" },
      );
      return;
    }
    setPrepared(current);
    setRequest(incoming);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- receives native update intents independently of the local backend connection
  useEffect(() => {
    if (!command) return;
    const unsubscribe = command.onRequest((incoming) => {
      void receive(incoming).catch(async () => {
        await command.complete({
          version: 1,
          requestId: incoming.requestId,
          ok: false,
          code: "internal-error",
          message: "The coordinated update could not be prepared.",
        });
      });
    });
    void command.setReady(true, rendererId);
    return () => {
      latestRequestId.current = null;
      unsubscribe();
      void command.setReady(false, rendererId);
    };
  }, [command]);

  const cancel = async () => {
    if (!request || !command) return;
    setRequest(null);
    await command.complete({
      version: 1,
      requestId: request.requestId,
      ok: true,
      status: "cancelled",
    });
  };
  const confirm = async () => {
    if (!request || !command) return;
    const currentRequest = request;
    setRequest(null);
    if (
      !(await command.complete({
        version: 1,
        requestId: currentRequest.requestId,
        ok: true,
        status: "started",
      }))
    ) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not update T3 Code",
          description: "This update request expired or was replaced. Start the update again.",
        }),
      );
      return;
    }
    try {
      const bridge = window.desktopBridge!;
      await everything
        .run({
          ...(action === "download"
            ? {
                downloadLocal: (reportError) =>
                  downloadLocalUpdate(bridge, { notifyDownloaded: false, reportError }),
              }
            : {}),
          ...(action !== "none"
            ? {
                installLocal: (reportError) =>
                  installLocalUpdate(bridge, reportError, localVersion ?? undefined),
              }
            : {}),
        })
        .finally(() => command.finish(currentRequest.requestId));
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not update T3 Code",
          description: error instanceof Error ? error.message : "The coordinated update failed.",
        }),
      );
    }
  };
  if (!request) return null;
  return (
    <UpdateEverythingDialog
      open
      onOpenChange={(open) => {
        if (!open) void cancel();
      }}
      version={everything.version}
      providerCount={everything.providerCount}
      rows={everything.rows}
      restarts={everything.restarts}
      checking={checkingProviders}
      onConfirm={() => void confirm()}
    />
  );
}
