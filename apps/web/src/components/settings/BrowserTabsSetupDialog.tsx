import type { BrowserTabsStatus } from "@t3tools/contracts";
import { CircleCheckIcon } from "lucide-react";
import { useState } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
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

/** A browser agents can use right now: running with remote debugging on. */
export function readyBrowser(status: BrowserTabsStatus | null) {
  return status?.browsers.find((browser) => browser.remoteDebugging);
}

/**
 * Setup for browser tab access. Agents attach to the browser on the host that
 * has remote debugging on, and the browser asks to allow each connection, so
 * someone at the host turns it on and approves it. Done installs Chrome
 * DevTools MCP on the host.
 */
export function BrowserTabsSetupDialog({
  hostLabel,
  status,
  onRefresh,
  onFinish,
  onClose,
}: {
  hostLabel: string;
  status: BrowserTabsStatus | null;
  onRefresh: () => void;
  onFinish: () => Promise<boolean>;
  onClose: () => void;
}) {
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard<string>({ onCopy: setCopiedUrl });
  const browsers = status?.browsers ?? [];
  const ready = readyBrowser(status) !== undefined;
  const finish = async () => {
    setInstalling(true);
    setError(null);
    try {
      if (await onFinish()) onClose();
      else setError("Chrome DevTools MCP did not install. Try again.");
    } finally {
      setInstalling(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !installing) onClose();
      }}
    >
      <DialogPopup showCloseButton={!installing}>
        <DialogHeader>
          <DialogTitle>Use your browser tabs</DialogTitle>
          <DialogDescription>
            Agents connect to the browser on {hostLabel} that has remote debugging on. On{" "}
            {hostLabel}, open the browser's page below and turn on remote debugging. The browser
            asks to allow each connection, so someone at {hostLabel} has to approve it.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {status !== null && browsers.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No Chromium browser found. Install Chrome, Edge, Brave, Helium, or Chromium.
            </p>
          ) : (
            <div className="space-y-2">
              {browsers.map((browser) => (
                <div
                  key={browser.id}
                  className="flex items-center gap-3 rounded-lg border px-3 py-2 text-sm"
                >
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{browser.name}</p>
                    {browser.remoteDebugging ? null : (
                      <p className="truncate font-mono text-xs text-muted-foreground">
                        {browser.inspectUrl}
                      </p>
                    )}
                  </div>
                  {browser.remoteDebugging ? (
                    <span role="status" className="flex items-center gap-1 text-xs text-success">
                      <CircleCheckIcon className="size-4" aria-hidden="true" />
                      On
                    </span>
                  ) : (
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => copyToClipboard(browser.inspectUrl, browser.inspectUrl)}
                    >
                      {isCopied && copiedUrl === browser.inspectUrl ? "Copied" : "Copy link"}
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
          {error ? (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" disabled={installing} onClick={onClose}>
            Finish later
          </Button>
          <Button variant="outline" disabled={installing} onClick={onRefresh}>
            Check again
          </Button>
          <Button
            disabled={!ready || installing}
            aria-busy={installing}
            onClick={() => void finish()}
          >
            {installing ? "Installing…" : "Done"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
