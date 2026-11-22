// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - The native client stand-in reads the real loopback feed and archive.
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import type * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { MacUpdater } from "electron-updater/out/MacUpdater.js";
import { expect, it, vi } from "vite-plus/test";

it.each(["closed feed", "interrupted transfer"] as const)(
  "retries the cached Mac archive after a failed handoff (%s)",
  async (fault) => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-mac-updater-"));
    const bytes = Buffer.alloc(256 * 1024, 0x61);
    const downloadedFile = NodePath.join(dir, "update.zip");
    let feed: { url: string; headers: Record<string, string> };
    let received: Buffer | undefined;
    let attempts = 0;
    const events = new NodeEvents.EventEmitter();
    const native = Object.assign(events, {
      setFeedURL: (value: typeof feed) => {
        feed = value;
      },
      quitAndInstall: vi.fn(),
      checkForUpdates: async () => {
        try {
          if (++attempts === 1 && fault === "closed feed") {
            // Make the first handoff fail, leaving the downloaded archive intact.
            const closed = NodeEvents.once(updater.server, "close");
            updater.server.close();
            await closed;
          }
          const manifest = await fetch(feed.url, { headers: feed.headers });
          const { url } = (await manifest.json()) as { url: string };
          if (attempts === 1 && fault === "interrupted transfer") {
            updater.server.prependOnceListener("request", (_request, response) => {
              response.once("pipe", (source) => {
                source.once("data", () => response.destroy());
              });
            });
          }
          const zip = await fetch(url);
          received = Buffer.from(await zip.arrayBuffer());
          events.emit("update-downloaded");
        } catch (cause) {
          events.emit("error", cause);
        }
      },
    });
    const reportError = vi.fn();
    native.on("error", reportError);
    // Substitute only the native Squirrel client. The package owns the server, archive stream,
    // private feed credentials and install listeners exercised by the two attempts.
    const published = vi.fn();
    const updater = Object.assign(Object.create(MacUpdater.prototype), {
      nativeUpdater: native,
      autoRunAppAfterInstall: true,
      autoInstallOnAppQuit: false,
      _logger: { info: vi.fn(), warn: vi.fn() },
      dispatchUpdateDownloaded: published,
    }) as {
      updateDownloaded: (
        file: { url: URL; info: { size: number } },
        event: { downloadedFile: string },
      ) => Promise<unknown>;
      quitAndInstall: () => void;
      server: NodeHttp.Server;
    };
    try {
      await NodeFSP.writeFile(downloadedFile, bytes);
      await updater.updateDownloaded(
        { url: new URL("https://example.invalid/release.zip"), info: { size: bytes.length } },
        { downloadedFile },
      );
      const listeningAtDownload = updater.server?.listening ?? false;
      const firstFailure = NodeEvents.once(native, "error");
      updater.quitAndInstall();
      await firstFailure;
      const staged = NodeEvents.once(native, "update-downloaded");
      updater.quitAndInstall();
      updater.quitAndInstall();
      await staged;
      expect(native.quitAndInstall).toHaveBeenCalledTimes(1);
      expect(attempts).toBe(2);
      expect(received).toEqual(bytes);
      expect(listeningAtDownload).toBe(false);
      expect(published).toHaveBeenCalledTimes(1);
      expect(native.listenerCount("update-downloaded")).toBe(0);
      expect(native.listeners("error")).toEqual([reportError]);
      expect(reportError).toHaveBeenCalledTimes(1);
    } finally {
      if (updater.server?.listening) updater.server.close();
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  },
);
