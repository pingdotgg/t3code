import type { DesktopSshPasswordPromptRequest } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { render, stubGlobal } from "../../../test/render";
import { SshPasswordPromptDialog, startSshPasswordPromptQueue } from "./SshPasswordPromptDialog";

it("shows a prompt that arrived before the dialog mounted", async () => {
  const listeners: Array<(request: DesktopSshPasswordPromptRequest) => void> = [];
  using _bridge = stubGlobal("desktopBridge", {
    onSshPasswordPrompt: (listener: (request: DesktopSshPasswordPromptRequest) => void) => {
      listeners.push(listener);
      return () => listeners.splice(listeners.indexOf(listener), 1);
    },
    resolveSshPasswordPrompt: async () => undefined,
  });
  const stopQueue = startSshPasswordPromptQueue();
  using _queue = { [Symbol.dispose]: stopQueue };

  // The desktop asks while the app is still on a page without the dialog (pairing, sign-in).
  for (const listener of listeners) {
    listener({
      requestId: "ssh-1",
      destination: "devbox",
      username: "julius",
      prompt: "julius@devbox's password:",
      expiresAt: "2999-01-01T00:00:00.000Z",
    });
  }

  await using screen = await render(<SshPasswordPromptDialog />);
  await expect.element(screen.getByText("SSH verification required")).toBeVisible();
});
