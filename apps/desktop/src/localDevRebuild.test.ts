import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  launchLocalDevRebuild,
  readEmbeddedDevSourceRoot,
  resolveLocalDevRebuildState,
} from "./localDevRebuild.ts";

function makeCheckout(): string {
  const sourceRoot = FS.mkdtempSync(Path.join(OS.tmpdir(), "t3code-rebuild-"));
  FS.mkdirSync(Path.join(sourceRoot, "scripts"));
  FS.writeFileSync(
    Path.join(sourceRoot, "package.json"),
    JSON.stringify({ name: "@t3tools/monorepo" }),
  );
  FS.writeFileSync(Path.join(sourceRoot, "scripts", "install-t3-dev.sh"), "#!/bin/bash\n");
  return sourceRoot;
}

describe("local Dev rebuild", () => {
  it("reads the source root embedded in packaged metadata", () => {
    const appRoot = FS.mkdtempSync(Path.join(OS.tmpdir(), "t3code-app-"));
    FS.writeFileSync(
      Path.join(appRoot, "package.json"),
      JSON.stringify({ t3codeDevSourceRoot: "/tmp/t3code" }),
    );

    expect(readEmbeddedDevSourceRoot(appRoot)).toBe("/tmp/t3code");
  });

  it("enables rebuilds only for a valid packaged macOS Dev checkout", () => {
    const sourceRoot = makeCheckout();

    expect(
      resolveLocalDevRebuildState({
        isPackaged: true,
        isDevAppFlavor: true,
        platform: "darwin",
        sourceRoot,
      }),
    ).toEqual({ enabled: true, sourceRoot: FS.realpathSync(sourceRoot), reason: null });

    expect(
      resolveLocalDevRebuildState({
        isPackaged: true,
        isDevAppFlavor: false,
        platform: "darwin",
        sourceRoot,
      }).enabled,
    ).toBe(false);
  });

  it("launches the fixed installer as a detached process after spawn succeeds", async () => {
    const sourceRoot = makeCheckout();
    const logDirectory = FS.mkdtempSync(Path.join(OS.tmpdir(), "t3code-rebuild-log-"));
    const unref = vi.fn();
    const child = Object.assign(new EventEmitter(), { unref });
    const spawn = vi.fn(() => child);

    const resultPromise = launchLocalDevRebuild(
      { enabled: true, sourceRoot, reason: null },
      logDirectory,
      spawn as unknown as typeof import("node:child_process").spawn,
    );
    let settled = false;
    void resultPromise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    child.emit("spawn");
    const result = await resultPromise;

    expect(result.accepted).toBe(true);
    expect(spawn).toHaveBeenCalledWith(
      "/bin/bash",
      [Path.join(sourceRoot, "scripts", "install-t3-dev.sh")],
      expect.objectContaining({
        cwd: sourceRoot,
        detached: true,
        env: expect.objectContaining({
          T3CODE_DEV_REBUILD_LOG_PATH: Path.join(logDirectory, "dev-rebuild.log"),
        }),
        stdio: "ignore",
      }),
    );
    expect(unref).toHaveBeenCalledOnce();
  });

  it("rejects a missing checkout and reports synchronous launch failures", async () => {
    expect(
      resolveLocalDevRebuildState({
        isPackaged: true,
        isDevAppFlavor: true,
        platform: "darwin",
        sourceRoot: "/missing/t3code-checkout",
      }).enabled,
    ).toBe(false);

    const sourceRoot = makeCheckout();
    const logDirectory = FS.mkdtempSync(Path.join(OS.tmpdir(), "t3code-rebuild-log-"));
    const result = await launchLocalDevRebuild(
      { enabled: true, sourceRoot, reason: null },
      logDirectory,
      vi.fn(() => {
        throw new Error("spawn failed");
      }) as unknown as typeof import("node:child_process").spawn,
    );

    expect(result).toEqual({
      accepted: false,
      logPath: Path.join(logDirectory, "dev-rebuild.log"),
      message: "spawn failed",
    });
  });

  it("reports asynchronous launch failures and notifies when the child exits", async () => {
    const sourceRoot = makeCheckout();
    const logDirectory = FS.mkdtempSync(Path.join(OS.tmpdir(), "t3code-rebuild-log-"));
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    const onExit = vi.fn();
    const resultPromise = launchLocalDevRebuild(
      { enabled: true, sourceRoot, reason: null },
      logDirectory,
      vi.fn(() => child) as unknown as typeof import("node:child_process").spawn,
      onExit,
    );

    child.emit("error", new Error("async spawn failed"));

    await expect(resultPromise).resolves.toEqual({
      accepted: false,
      logPath: Path.join(logDirectory, "dev-rebuild.log"),
      message: "async spawn failed",
    });
    child.emit("exit", 1, null);
    expect(onExit).toHaveBeenCalledOnce();
  });
});
