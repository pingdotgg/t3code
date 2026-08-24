import { useEffect, useState } from "react";

import { SshPasswordRequestDialog } from "../SshPasswordRequestDialog";
import {
  enqueueDesktopSshPasswordPrompt,
  type QueuedDesktopSshPasswordPromptRequest,
} from "./sshPasswordPromptQueue";

export function SshPasswordPromptDialog() {
  const [queue, setQueue] = useState<readonly QueuedDesktopSshPasswordPromptRequest[]>([]);
  const currentRequest = queue[0] ?? null;

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge?.onSshPasswordPrompt) {
      return;
    }

    return bridge.onSshPasswordPrompt((request) => {
      const receivedAtMs = Date.now();
      setQueue((currentQueue) =>
        enqueueDesktopSshPasswordPrompt(currentQueue, request, receivedAtMs),
      );
    });
  }, []);

  if (!currentRequest) {
    return null;
  }

  return (
    <SshPasswordRequestDialog
      key={currentRequest.requestId}
      request={currentRequest}
      onRespond={(password) =>
        window.desktopBridge?.resolveSshPasswordPrompt(currentRequest.requestId, password) ??
        Promise.resolve()
      }
      onRemove={(requestId) => {
        setQueue((currentQueue) =>
          currentQueue[0]?.requestId === requestId ? currentQueue.slice(1) : currentQueue,
        );
      }}
    />
  );
}
