import type { EnvironmentId, ProjectScript, ThreadId } from "@t3tools/contracts";
import { MonitorUpIcon, PuzzleIcon } from "lucide-react";
import { memo, useMemo, useState } from "react";

import {
  resolveBrowserAgentPreviewUrl,
  resolveBrowserAgentReachablePreviewUrl,
} from "../../browserAgents";
import {
  autoPairBrowserAgent,
  isBrowserAgentExtensionUnavailableError,
  isNoBrowserAgentConnectedError,
} from "../../browserAgentPairing";
import { getPrimaryEnvironmentConnection } from "../../environments/runtime";
import { useSettings } from "../../hooks/useSettings";
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

export const PreviewButton = memo(function PreviewButton({
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
  const [isOpeningPreview, setIsOpeningPreview] = useState(false);
  const [extensionDownloadUrl, setExtensionDownloadUrl] = useState<string | null>(null);
  const customPreviewUrl = useSettings((settings) => settings.browserAgentPreviewUrl);
  const devServerUrl = useMemo(
    () =>
      resolveBrowserAgentPreviewUrl({
        customPreviewUrl,
        detectedDevServerUrl,
        scripts: activeProjectScripts,
      }),
    [activeProjectScripts, customPreviewUrl, detectedDevServerUrl],
  );

  const openPreviewInBrowser = () => {
    if (isOpeningPreview) return;
    if (!activeProjectName) {
      return;
    }

    setIsOpeningPreview(true);
    void (async () => {
      const connection = getPrimaryEnvironmentConnection();
      const openPreview = async () => {
        const reachablePreviewUrl = await resolveBrowserAgentReachablePreviewUrl(devServerUrl);
        return await connection.client.browserAgents.openOrFocusPreview({
          environmentId: activeThreadEnvironmentId,
          threadId: activeThreadId,
          devServerUrl: reachablePreviewUrl,
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
            title: "Preview failed",
            description,
          }),
        );
      })
      .finally(() => {
        setIsOpeningPreview(false);
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
              aria-label="Preview"
              disabled={isOpeningPreview || !activeProjectName}
              onClick={openPreviewInBrowser}
            />
          }
        >
          <MonitorUpIcon className="size-3" />
          <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
            Preview
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
              Preview needs the T3 Code Browser Agent extension installed in this browser.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <p className="text-muted-foreground text-sm leading-6">
              Install the extension, keep it enabled, then retry Preview.
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
