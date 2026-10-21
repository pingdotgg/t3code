import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import { Button } from "../ui/button";

function subscribeToClerkOAuthPending(onChange: () => void): () => void {
  return window.desktopBridge?.onClerkOAuthPendingChange?.(() => onChange()) ?? (() => {});
}

function readClerkOAuthPending(): boolean {
  return window.desktopBridge?.isClerkOAuthPending?.() ?? false;
}

export function ClerkOAuthPendingBar() {
  const pending = useSyncExternalStore(subscribeToClerkOAuthPending, readClerkOAuthPending);
  if (!pending) return null;
  return createPortal(
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-10001 flex justify-center px-4">
      <div
        role="status"
        className="pointer-events-auto flex items-center gap-3 rounded-lg border bg-popover py-2 pr-2 pl-4 text-sm text-popover-foreground shadow-xl"
      >
        Finish signing in in your browser.
        <Button
          size="sm"
          variant="outline"
          onClick={() => window.desktopBridge?.cancelClerkOAuth?.()}
        >
          Cancel
        </Button>
      </div>
    </div>,
    document.body,
  );
}
