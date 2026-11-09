import type { DesktopSshPasswordPromptRequest } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { render, stubGlobal } from "../../../test/render";
import { SshPasswordPromptDialog, startSshPasswordPromptQueue } from "./SshPasswordPromptDialog";

function stubPromptBridge() {
  const listeners: Array<(request: DesktopSshPasswordPromptRequest) => void> = [];
  const settledListeners: Array<(requestId: string) => void> = [];
  const bridge = stubGlobal("desktopBridge", {
    onSshPasswordPrompt: (listener: (request: DesktopSshPasswordPromptRequest) => void) => {
      listeners.push(listener);
      return () => listeners.splice(listeners.indexOf(listener), 1);
    },
    onSshPasswordPromptSettled: (listener: (requestId: string) => void) => {
      settledListeners.push(listener);
      return () => settledListeners.splice(settledListeners.indexOf(listener), 1);
    },
    resolveSshPasswordPrompt: async () => undefined,
  });
  return {
    prompt: (requestId: string, destination: string) => {
      for (const listener of listeners) {
        listener({
          requestId,
          destination,
          username: "julius",
          prompt: `julius@${destination}'s password:`,
          expiresAt: "2999-01-01T00:00:00.000Z",
        });
      }
    },
    settle: (requestId: string) => {
      for (const listener of settledListeners) listener(requestId);
    },
    [Symbol.dispose]: () => bridge[Symbol.dispose](),
  };
}

it("drops a prompt the desktop ended, whether it is on screen or still waiting", async () => {
  using bridge = stubPromptBridge();
  const stopQueue = startSshPasswordPromptQueue();
  using _queue = { [Symbol.dispose]: stopQueue };
  await using screen = await render(<SshPasswordPromptDialog />);

  bridge.prompt("ssh-1", "first-host");
  bridge.prompt("ssh-1", "first-host");
  bridge.prompt("ssh-2", "second-host");
  bridge.prompt("ssh-3", "third-host");
  await expect.element(screen.getByText("julius@first-host")).toBeVisible();

  // ssh-2 ended while it waited behind ssh-1, and ssh-1 ended on screen.
  bridge.settle("ssh-2");
  bridge.settle("ssh-1");
  await expect.element(screen.getByText("julius@third-host")).toBeVisible();

  bridge.settle("ssh-3");
  await expect.element(screen.getByText("SSH verification required")).not.toBeInTheDocument();
});

it("shows a prompt that arrived before the dialog mounted", async () => {
  using bridge = stubPromptBridge();
  const stopQueue = startSshPasswordPromptQueue();
  using _queue = { [Symbol.dispose]: stopQueue };

  // The desktop asks while the app is still on a page without the dialog (pairing, sign-in).
  bridge.prompt("ssh-1", "devbox");

  await using screen = await render(<SshPasswordPromptDialog />);
  await expect.element(screen.getByRole("dialog", { name: "SSH Password Required" })).toBeVisible();
});
