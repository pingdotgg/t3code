import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  isHostFilesystemConnectionTarget,
  openChatMarkdownFile,
} from "./ChatMarkdownDesktopBridge";

function fileOpenHarness(options?: { readonly hostLocal?: boolean }) {
  const openPath = vi.fn(async (_path: string) => undefined);
  const openInEditor = vi.fn(async () => undefined);
  const openInBrowser = vi.fn(async () => undefined);

  return {
    openPath,
    openInEditor,
    openInBrowser,
    open: (filePath: string, browserPreviewAvailable = false) =>
      openChatMarkdownFile({
        filePath,
        desktopBridge: options?.hostLocal === false ? undefined : { openPath },
        openInEditor,
        ...(browserPreviewAvailable ? { openInBrowser } : {}),
      }),
  };
}

describe("ChatMarkdownDesktopBridge", () => {
  it.each([
    "/Users/toviastorres/Downloads/product image.png",
    "/Users/toviastorres/Downloads/product demo.html",
    "/Users/toviastorres/Downloads/model.blend",
    "/Users/toviastorres/Downloads/.hidden screenshot.png",
  ])("opens a host-local desktop artifact in its native app: %s", async (filePath) => {
    const harness = fileOpenHarness();

    await harness.open(filePath, filePath.endsWith(".html"));

    expect(harness.openPath).toHaveBeenCalledWith(filePath);
    expect(harness.openInEditor).not.toHaveBeenCalled();
    expect(harness.openInBrowser).not.toHaveBeenCalled();
  });

  it.each([
    "/Users/toviastorres/Projects/t3code/src/example.ts",
    "/Users/toviastorres/Projects/t3code/infra/main.tf",
    "/Users/toviastorres/Projects/t3code/.gitignore",
    "/Users/toviastorres/Projects/t3code/.env.local",
    "/Users/toviastorres/Projects/t3code/Dockerfile.dev",
    "/Users/toviastorres/Projects/t3code/go.mod",
    "/Users/toviastorres/Projects/t3code/notebook.ipynb",
  ])("keeps source and config files in the editor: %s", async (filePath) => {
    const harness = fileOpenHarness();

    await harness.open(filePath);

    expect(harness.openPath).not.toHaveBeenCalled();
    expect(harness.openInEditor).toHaveBeenCalledOnce();
  });

  it("never sends remote paths to the desktop shell", async () => {
    const harness = fileOpenHarness({ hostLocal: false });

    await harness.open("/remote/build/product image.png");

    expect(harness.openPath).not.toHaveBeenCalled();
    expect(harness.openInEditor).toHaveBeenCalledOnce();
  });

  it("keeps the integrated-browser fallback for remote HTML", async () => {
    const harness = fileOpenHarness({ hostLocal: false });

    await harness.open("/remote/build/product demo.html", true);

    expect(harness.openPath).not.toHaveBeenCalled();
    expect(harness.openInBrowser).toHaveBeenCalledOnce();
    expect(harness.openInEditor).not.toHaveBeenCalled();
  });

  it("propagates native open errors to the visible chat error handler", async () => {
    const harness = fileOpenHarness();
    const error = new Error("There is no application set to open the file.");
    harness.openPath.mockRejectedValue(error);

    await expect(harness.open("/Users/toviastorres/Downloads/product image.png")).rejects.toBe(
      error,
    );
  });

  it("only treats the primary desktop target as sharing the host filesystem", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const common = { environmentId, label: "Test" };

    expect(
      isHostFilesystemConnectionTarget(
        new PrimaryConnectionTarget({
          ...common,
          httpBaseUrl: "http://127.0.0.1:3773",
          wsBaseUrl: "ws://127.0.0.1:3773",
        }),
      ),
    ).toBe(true);
    expect(
      [
        new BearerConnectionTarget({ ...common, connectionId: "local:wsl:Ubuntu" }),
        new RelayConnectionTarget(common),
        new SshConnectionTarget({ ...common, connectionId: "ssh:server" }),
      ].every((target) => !isHostFilesystemConnectionTarget(target)),
    ).toBe(true);
  });
});
