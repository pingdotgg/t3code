// @effect-diagnostics-next-line nodeBuiltinImport:off -- The Muse SDK spawns with Node's child_process, so the launch test quotes arguments the same way.
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { spawnMspConnection, type MspHandshake, type SpawnedMspConnection } from "@muse-code/sdk";
import { it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { afterEach, describe, expect, vi } from "vite-plus/test";
import {
  createMuseSdkHost,
  createMuseSdkHostEffect,
  makeMuseEnvironment,
  museApprovalMode,
  museLaunch,
  museVerbatimPath,
  museWorkspaceRoot,
  type MuseSdkHost,
} from "./sdk.ts";

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
  const initializing = pending<void>();
  const initialize = vi.fn(() => {
    initializing.resolve();
    return startup.promise;
  });
  const close = vi.fn(() => {
    closing.resolve();
    return shutdown.promise;
  });
  const handshake = { initialize, close } as unknown as MspHandshake;
  vi.mocked(spawnMspConnection).mockReturnValue(handshake);
  const ready = {
    connection: {},
    initializeResult: { grantedCapabilities: [], schema: { version: 1 } },
    exited: shutdown.promise,
    fingerprintWarning: { warning: "additive optional" },
  } as unknown as SpawnedMspConnection;
  return { startup, shutdown, closing, initializing, initialize, close, ready };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("Muse SDK host", () => {
  it.each(["META_API_KEY", "meta_api_key", "Meta_Api_Key"])(
    "excludes %s without reading its value or mutating the supplied environment",
    (key) => {
      const source: NodeJS.ProcessEnv = { PATH: "/bin", MUSE_TEST: "yes" };
      const read = vi.fn(() => {
        throw new Error("The API override must not be read.");
      });
      Object.defineProperty(source, key, { enumerable: true, get: read });
      expect(makeMuseEnvironment(source)).toEqual({
        PATH: "/bin",
        MUSE_TEST: "yes",
        MUSE_NO_AUTO_UPDATE: "1",
      });
      expect(read).not.toHaveBeenCalled();
      expect(Object.keys(source)).toContain(key);
    },
  );

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
    expect(host.initializeResult.grantedCapabilities).toEqual([]);
    expect(vi.mocked(spawnMspConnection).mock.lastCall?.[0].args).toEqual([
      "serve",
      "--disable-shell",
      "--disable-write",
      "--no-session-log",
    ]);
    success.shutdown.resolve({ code: 0, signal: null });
    await host.close();
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

  it.effect(
    "keeps Effect startup resources alive until interrupted initialization shuts down",
    () =>
      Effect.gen(function* () {
        const fake = mockSpawn();
        let released = false;
        const fiber = yield* Effect.forkChild(
          createMuseSdkHostEffect({ binaryPath: "muse" }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                released = true;
              }),
            ),
          ),
        );
        yield* Effect.promise(() => fake.initializing.promise);
        const interrupted = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild);
        yield* Effect.promise(() => fake.closing.promise);
        expect(released).toBe(false);
        fake.shutdown.resolve({ code: 0, signal: null });
        yield* Fiber.join(interrupted);
        expect(released).toBe(true);
        expect(fake.close).toHaveBeenCalledOnce();
      }),
  );

  it.effect("closes a fulfilled host when interruption wins before acquisition is delivered", () =>
    Effect.gen(function* () {
      const started = pending<void>();
      const startup = pending<MuseSdkHost>();
      const closing = pending<void>();
      const shutdown = pending<void>();
      const host = {
        close: vi.fn(() => {
          closing.resolve();
          return shutdown.promise;
        }),
      } as unknown as MuseSdkHost;
      let released = false;
      const fiber = yield* Effect.forkChild(
        createMuseSdkHostEffect({ binaryPath: "muse" }, () => {
          started.resolve();
          return startup.promise;
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              released = true;
            }),
          ),
        ),
      );
      yield* Effect.promise(() => started.promise);
      startup.resolve(host);
      const interrupted = yield* Fiber.interrupt(fiber).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Effect.promise(() => closing.promise);
      expect(released).toBe(false);
      shutdown.resolve();
      yield* Fiber.join(interrupted);
      expect(released).toBe(true);
      expect(host.close).toHaveBeenCalledOnce();
    }),
  );
});

describe("Muse launch", () => {
  const CMD = "C:\\Windows\\system32\\cmd.exe";
  const onWindows = (resolved: string | undefined, env: NodeJS.ProcessEnv = { ComSpec: CMD }) =>
    museLaunch("muse", env).pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(SpawnExecutableResolution, () => resolved),
    );

  it.effect("starts the binary itself off Windows", () =>
    Effect.gen(function* () {
      expect(yield* museLaunch("muse")).toEqual({ command: "muse", args: [] });
    }).pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(SpawnExecutableResolution, () => {
        throw new Error("Nothing is resolved off Windows.");
      }),
    ),
  );

  // Node spawns neither a bare `muse` nor a `.cmd` file without a shell on Windows.
  it.effect("runs an exe directly and a launcher script under cmd.exe on Windows", () =>
    Effect.gen(function* () {
      expect(yield* onWindows("C:\\Muse\\muse.exe")).toEqual({
        command: "C:\\Muse\\muse.exe",
        args: [],
      });
      // Node quotes a path with spaces, and the `@` before it keeps cmd from dropping the quotes.
      const spaced = "C:\\Users\\Jane Doe\\AppData\\Local\\Programs\\muse\\muse.cmd";
      expect(yield* onWindows(spaced)).toEqual({ command: CMD, args: ["/d", "/c", "@", spaced] });
      const spacedAmpersand = "C:\\Users\\R&D Team\\AppData\\Local\\Programs\\muse\\muse.cmd";
      expect(yield* onWindows(spacedAmpersand)).toEqual({
        command: CMD,
        args: ["/d", "/c", "@", spacedAmpersand],
      });
      // Unquoted, cmd would split the command at `&`.
      expect(yield* onWindows("C:\\Users\\R&D(1)\\muse.cmd")).toEqual({
        command: CMD,
        args: ["/d", "/c", "C:\\Users\\R^&D^(1^)\\muse.cmd"],
      });
      expect((yield* onWindows("C:\\Muse\\muse.bat", { SYSTEMROOT: "C:\\Windows" })).command).toBe(
        "C:\\Windows\\System32\\cmd.exe",
      );
      // A binary that cannot be found is spawned as given, so the failure reports it.
      expect(yield* onWindows(undefined)).toEqual({ command: "muse", args: [] });
    }),
  );

  // cmd's quote rules only show with a real cmd.exe, spawning as the SDK does.
  it.effect("starts a real launcher from a folder with spaces and cmd metacharacters", () =>
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) !== "win32") return;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const folder = path.join(
        yield* fs.makeTempDirectoryScoped({ prefix: "MuseLaunch-" }),
        "R&D Team (x) @ ^y",
      );
      yield* fs.makeDirectory(folder);
      const launcher = path.join(folder, "muse.cmd");
      // Records its arguments next to itself; reaching the file at all proves cmd found it.
      yield* fs.writeFileString(launcher, '@echo off\r\necho %*>"%~dp0args.txt"\r\n');
      const launch = yield* museLaunch(launcher);
      const run = NodeChildProcess.spawnSync(launch.command, [...launch.args, "serve", "--x"], {
        cwd: folder,
        encoding: "utf8",
      });
      expect(run.status, run.stderr).toBe(0);
      expect((yield* fs.readFileString(path.join(folder, "args.txt"))).trim()).toBe("serve --x");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("starts Muse's Windows launcher through cmd.exe", () =>
    Effect.gen(function* () {
      const fake = mockSpawn();
      const starting = yield* Effect.forkChild(
        createMuseSdkHostEffect({
          binaryPath: "muse",
          environment: { ComSpec: CMD },
          readOnly: true,
        }),
      );
      yield* Effect.promise(() => fake.initializing.promise);
      const spawned = vi.mocked(spawnMspConnection).mock.lastCall?.[0];
      fake.startup.resolve(fake.ready);
      const host = yield* Fiber.join(starting);
      fake.shutdown.resolve({ code: 0, signal: null });
      yield* Effect.promise(() => host.close());
      expect(spawned).toMatchObject({
        command: CMD,
        args: [
          "/d",
          "/c",
          "C:\\Muse\\muse.cmd",
          "serve",
          "--disable-shell",
          "--disable-write",
          "--no-session-log",
        ],
      });
    }).pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(SpawnExecutableResolution, () => "C:\\Muse\\muse.cmd"),
    ),
  );

  it.effect("passes launcher arguments to the binary that cmd.exe starts", () =>
    Effect.gen(function* () {
      const fake = mockSpawn();
      const starting = yield* Effect.forkChild(
        createMuseSdkHostEffect({
          binaryPath: "muse",
          launchArgs: ["--launcher-arg"],
          environment: { ComSpec: CMD },
          readOnly: true,
        }),
      );
      yield* Effect.promise(() => fake.initializing.promise);
      const spawned = vi.mocked(spawnMspConnection).mock.lastCall?.[0];
      fake.startup.resolve(fake.ready);
      const host = yield* Fiber.join(starting);
      fake.shutdown.resolve({ code: 0, signal: null });
      yield* Effect.promise(() => host.close());
      expect(spawned).toMatchObject({
        command: CMD,
        args: [
          "/d",
          "/c",
          "C:\\Muse\\muse.cmd",
          "--launcher-arg",
          "serve",
          "--disable-shell",
          "--disable-write",
          "--no-session-log",
        ],
      });
    }).pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(SpawnExecutableResolution, () => "C:\\Muse\\muse.cmd"),
    ),
  );
});

describe("Muse workspace root", () => {
  it("writes Windows paths in their verbatim form", () => {
    expect(museVerbatimPath("C:\\Users\\Person\\repo")).toBe("\\\\?\\C:\\Users\\Person\\repo");
    expect(museVerbatimPath("\\\\server\\share\\repo")).toBe("\\\\?\\UNC\\server\\share\\repo");
    expect(museVerbatimPath("\\\\?\\C:\\repo")).toBe("\\\\?\\C:\\repo");
  });

  it.effect("leaves the root alone off Windows", () =>
    Effect.gen(function* () {
      expect(yield* museWorkspaceRoot("/workspace/repo")).toBe("/workspace/repo");
    }).pipe(Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect("keeps a Windows root it cannot resolve, in verbatim form", () =>
    Effect.gen(function* () {
      expect(yield* museWorkspaceRoot("C:\\definitely-missing\\repo")).toBe(
        "\\\\?\\C:\\definitely-missing\\repo",
      );
      // `/` would be taken literally inside a verbatim path.
      expect(yield* museWorkspaceRoot("C:/definitely-missing/repo")).toBe(
        "\\\\?\\C:\\definitely-missing\\repo",
      );
      expect(yield* museWorkspaceRoot("//server/share/missing")).toBe(
        "\\\\?\\UNC\\server\\share\\missing",
      );
    }).pipe(Effect.provideService(HostProcess.Platform, "win32")),
  );

  // FileSystem.realPath keeps the case it is given; Muse rejects a root whose case differs from the disk's.
  it.effect("fixes the case of a Windows root natively", () =>
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) !== "win32") return;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const created = yield* fs.makeTempDirectoryScoped({ prefix: "MuseRoot-" });
      const root = yield* museWorkspaceRoot(created.toLowerCase());
      expect(root.startsWith("\\\\?\\")).toBe(true);
      expect(root.endsWith(`\\${path.basename(created)}`)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
