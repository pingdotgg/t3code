import type { DesktopSshPasswordPromptRequest } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

import { render, stubGlobal } from "../../../test/render";
import { SshPasswordPromptDialog, startSshPasswordPromptQueue } from "./SshPasswordPromptDialog";

it("shows a prompt that arrived before the dialog mounted", async () => {
  const listeners: Array<(request: DesktopSshPasswordPromptRequest) => void> = [];
  const resolveSshPasswordPrompt = vi.fn(async () => undefined);
  using _bridge = stubGlobal("desktopBridge", {
    onSshPasswordPrompt: (listener: (request: DesktopSshPasswordPromptRequest) => void) => {
      listeners.push(listener);
      return () => listeners.splice(listeners.indexOf(listener), 1);
    },
    resolveSshPasswordPrompt,
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

  await using _screen = await render(<SshPasswordPromptDialog />);
  const dialog = page.getByRole("dialog", { name: "SSH Password Required" });
  await expect.element(dialog).toBeVisible();
  await expect.element(dialog.getByText("julius@devbox", { exact: true })).toBeVisible();
  await dialog.getByLabelText("Password", { exact: true }).fill("queued-password");
  await dialog.getByRole("button", { name: "Connect" }).click();
  expect(resolveSshPasswordPrompt).toHaveBeenCalledWith("ssh-1", "queued-password");
  await expect.element(dialog).not.toBeInTheDocument();
});
