import type { EnvironmentId, ProjectScript, ThreadId } from "@t3tools/contracts";
import { MonitorUpIcon, PuzzleIcon } from "lucide-react";
import { memo, useMemo, useState } from "react";

import {
  inferBrowserAgentDevServerUrl,
  resolveBrowserAgentTransferDevServerUrl,
} from "../../browserAgents";
import {
  autoPairBrowserAgent,
  isBrowserAgentExtensionUnavailableError,
  isNoBrowserAgentConnectedError,
} from "../../browserAgentPairing";
import { getPrimaryEnvironmentConnection } from "../../environments/runtime";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const TransferToBrowserButton = memo(function TransferToBrowserButton({
  activeProjectName,
  activeProjectScripts,
  activeThreadEnvironmentId,
  activeThreadId,
  detectedDevServerUrl,
}: {
  readonly activeProjectName: string | undefined;
  readonly activeProjectScripts: readonly ProjectScript[] | undefined;
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly activeThreadId: ThreadId;
  readonly detectedDevServerUrl: string | null;
}) {
  const [isTransferring, setIsTransferring] = useState(false);
  const [extensionDownloadUrl, setExtensionDownloadUrl] = useState<string | null>(null);
  const inferredDevServerUrl = useMemo(
    () => inferBrowserAgentDevServerUrl(activeProjectScripts),
    [activeProjectScripts],
  );
  const devServerUrl = detectedDevServerUrl ?? inferredDevServerUrl;

  const transferToBrowser = () => {
    if (isTransferring) return;
    if (!activeProjectName) {
      return;
    }

    setIsTransferring(true);
    void (async () => {
      const connection = getPrimaryEnvironmentConnection();
      const openPreview = async () => {
        const transferDevServerUrl = await resolveBrowserAgentTransferDevServerUrl(devServerUrl);
        return await connection.client.browserAgents.openOrFocusPreview({
          environmentId: activeThreadEnvironmentId,
          threadId: activeThreadId,
          devServerUrl: transferDevServerUrl,
          repoName: activeProjectName,
        });
      };

      try {
        await openPreview();
      } catch (error) {
        if (!isNoBrowserAgentConnectedError(error)) {
          throw error;
        }

        const pairingToastId = toastManager.add({
          type: "info",
          title: "Pairing browser extension",
        });
        try {
          await autoPairBrowserAgent(connection.client);
        } catch (pairingError) {
          if (isBrowserAgentExtensionUnavailableError(pairingError)) {
            setExtensionDownloadUrl(pairingError.downloadUrl);
            return;
          }
          throw pairingError;
        } finally {
          toastManager.close(pairingToastId);
        }
        await openPreview();
      }

      toastManager.add({
        type: "success",
        title: "Preview sent to browser",
      });
    })()
      .catch((error) => {
        const description =
          error instanceof Error
            ? error.message
            : "Install or reload the T3 Code Browser Agent extension and try again.";
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Transfer to browser failed",
            description,
          }),
        );
      })
      .finally(() => {
        setIsTransferring(false);
      });
  };

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              className="shrink-0"
              size="xs"
              variant="outline"
              aria-label="Transfer to Browser"
              disabled={isTransferring || !activeProjectName}
              onClick={transferToBrowser}
            />
          }
        >
          <MonitorUpIcon className="size-3" />
          <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
            Transfer to Browser
          </span>
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          Open or focus {devServerUrl} in a paired browser extension.
        </TooltipPopup>
      </Tooltip>

      <Dialog
        open={extensionDownloadUrl !== null}
        onOpenChange={(open) => {
          if (!open) {
            setExtensionDownloadUrl(null);
          }
        }}
      >
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>Chrome extension not installed</DialogTitle>
            <DialogDescription>
              Transfer to Browser needs the T3 Code Browser Agent extension installed in this
              browser.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <p className="text-muted-foreground text-sm leading-6">
              Install the extension, keep it enabled, then retry Transfer to Browser.
            </p>
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={() => setExtensionDownloadUrl(null)}>
              Cancel
            </Button>
            {extensionDownloadUrl ? (
              <Button
                render={
                  <a href={extensionDownloadUrl} onClick={() => setExtensionDownloadUrl(null)} />
                }
              >
                <PuzzleIcon />
                Install Extension
              </Button>
            ) : null}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
});
