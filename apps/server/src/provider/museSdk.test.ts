import { spawnMspConnection, type MspHandshake, type SpawnedMspConnection } from "@muse-code/sdk";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createMuseSdkHost, makeMuseEnvironment, museApprovalMode } from "./museSdk.ts";

vi.mock("@muse-code/sdk", () => ({ spawnMspConnection: vi.fn() }));

function pending<A>() {
  let resolve = (_value: A) => {};
  let reject = (_error: unknown) => {};
  const promise = new Promise<A>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function mockSpawn() {
  const startup = pending<SpawnedMspConnection>();
  const shutdown = pending<{ code: number; signal: null }>();
  const closing = pending<void>();
  const initialize = vi.fn(() => startup.promise);
  const close = vi.fn(() => {
    closing.resolve();
    return shutdown.promise;
  });
  const handshake = { initialize, close } as unknown as MspHandshake;
  vi.mocked(spawnMspConnection).mockReturnValue(handshake);
  const ready = {
    connection: {},
    initializeResult: { serverInfo: { version: "test" }, schema: { version: 1 } },
    exited: shutdown.promise,
    fingerprintWarning: { warning: "additive optional" },
  } as unknown as SpawnedMspConnection;
  return { startup, shutdown, closing, initialize, close, ready };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("Muse SDK host", () => {
  it("excludes META_API_KEY without reading its value or mutating the supplied environment", () => {
    const source: NodeJS.ProcessEnv = { PATH: "/bin", MUSE_TEST: "yes" };
    const read = vi.fn(() => {
      throw new Error("The API override must not be read.");
    });
    Object.defineProperty(source, "META_API_KEY", { enumerable: true, get: read });
    expect(makeMuseEnvironment(source)).toEqual({
      PATH: "/bin",
      MUSE_TEST: "yes",
      MUSE_NO_AUTO_UPDATE: "1",
    });
    expect(read).not.toHaveBeenCalled();
    expect(Object.keys(source)).toContain("META_API_KEY");
  });

  it("selects full access explicitly and keeps other runtime modes sandboxed", async () => {
    for (const mode of ["approval-required", "auto-accept-edits", "auto", "full-access"] as const) {
      const fake = mockSpawn();
      const running = createMuseSdkHost({
        binaryPath: "/custom/muse",
        cwd: "/workspace",
        runtimeMode: mode,
        environment: { PATH: "/bin" },
      });
      expect(vi.mocked(spawnMspConnection).mock.lastCall?.[0]).toMatchObject({
        command: "/custom/muse",
        cwd: "/workspace",
        args:
          mode === "full-access"
            ? ["serve", "--trust-workspace", "--disable-sandbox"]
            : ["serve", "--trust-workspace"],
      });
      expect(museApprovalMode(mode)).toBe(mode === "full-access" ? "allowAll" : "promptUnmatched");
      fake.startup.resolve(fake.ready);
      const host = await running;
      fake.shutdown.resolve({ code: 0, signal: null });
      await host.close();
      await host.close();
      expect(fake.close).toHaveBeenCalledOnce();
    }
  });

  it("bounds startup and waits for native shutdown after timeout", async () => {
    vi.useFakeTimers();
    const fake = mockSpawn();
    const startup = createMuseSdkHost({ binaryPath: "muse", startupTimeoutMs: 30 });
    let settled = false;
    const outcome = startup.then(
      () => {
        settled = true;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    await vi.advanceTimersByTimeAsync(31);
    expect(fake.close).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    fake.shutdown.resolve({ code: 0, signal: null });
    expect(await outcome).toMatchObject({ message: "Muse SDK initialization timed out." });
  });

  it("closes the pre-handshake host on abort and rejects only after shutdown", async () => {
    const fake = mockSpawn();
    const abort = new AbortController();
    const started = createMuseSdkHost({ binaryPath: "muse", signal: abort.signal });
    const reason = new Error("Cancelled by caller");
    const outcome = started.catch((error: unknown) => error);
    abort.abort(reason);
    expect(fake.close).toHaveBeenCalledOnce();
    fake.shutdown.resolve({ code: 0, signal: null });
    expect(await outcome).toBe(reason);
  });

  it("closes rejected initialization and keeps successful schema advisories usable", async () => {
    const failed = mockSpawn();
    const started = createMuseSdkHost({ binaryPath: "muse" });
    const outcome = started.catch((error: unknown) => error);
    failed.startup.reject(new Error("Handshake failed"));
    failed.shutdown.resolve({ code: 0, signal: null });
    expect(await outcome).toMatchObject({ message: "Handshake failed" });
    expect(failed.close).toHaveBeenCalledOnce();
    const success = mockSpawn();
    const ready = createMuseSdkHost({ binaryPath: "muse", readOnly: true });
    success.startup.resolve(success.ready);
    const host = await ready;
    expect(host.initializeResult.serverInfo.version).toBe("test");
    expect(vi.mocked(spawnMspConnection).mock.lastCall?.[0].args).toEqual([
      "serve",
      "--disable-shell",
      "--disable-write",
      "--no-session-log",
    ]);
    success.shutdown.resolve({ code: 0, signal: null });
    await host.close();
  });

  it("keeps read-only restrictions when session logging is needed for streamed generation", async () => {
    const fake = mockSpawn();
    const running = createMuseSdkHost({
      binaryPath: "muse",
      readOnly: true,
      sessionLogging: true,
    });
    fake.startup.resolve(fake.ready);
    const host = await running;
    expect(vi.mocked(spawnMspConnection).mock.lastCall?.[0].args).toEqual([
      "serve",
      "--disable-shell",
      "--disable-write",
    ]);
    fake.shutdown.resolve({ code: 0, signal: null });
    await host.close();
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it.each([undefined, 2])(
    "rejects unsupported envelope version %s and awaits shutdown",
    async (version) => {
      const fake = mockSpawn();
      const started = createMuseSdkHost({ binaryPath: "muse" });
      let settled = false;
      const outcome = started.catch((error: unknown) => {
        settled = true;
        return error;
      });
      fake.startup.resolve({
        ...fake.ready,
        initializeResult: {
          ...fake.ready.initializeResult,
          schema: { fingerprint: "test", version },
        },
      } as unknown as SpawnedMspConnection);
      await fake.closing.promise;
      expect(fake.close).toHaveBeenCalledOnce();
      expect(settled).toBe(false);
      fake.shutdown.resolve({ code: 0, signal: null });
      expect(await outcome).toMatchObject({
        message: "Muse SDK returned an unsupported protocol envelope version.",
      });
    },
  );

  it("does not spawn when already aborted and closes a ready host on later abort", async () => {
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      createMuseSdkHost({ binaryPath: "muse", signal: aborted.signal }),
    ).rejects.toBeDefined();
    expect(spawnMspConnection).not.toHaveBeenCalled();
    const fake = mockSpawn();
    const abort = new AbortController();
    const running = createMuseSdkHost({ binaryPath: "muse", signal: abort.signal });
    fake.startup.resolve(fake.ready);
    const host = await running;
    abort.abort();
    fake.shutdown.resolve({ code: 0, signal: null });
    await host.close();
    expect(fake.close).toHaveBeenCalledOnce();
  });
});
