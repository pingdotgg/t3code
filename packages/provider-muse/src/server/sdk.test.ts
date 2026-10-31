// @effect-diagnostics-next-line nodeBuiltinImport:off -- Mock native realpath to exercise macOS case correction on every platform.
import * as NodeFSP from "node:fs/promises";
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
import { afterEach, describe, expect, onTestFinished, vi } from "vite-plus/test";
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

vi.mock("node:fs/promises", { spy: true });

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

  it.effect(
    "observes native host exit while the SDK still waits for a detached stdout holder",
    () =>
      Effect.gen(function* () {
        if ((yield* HostProcess.Platform) === "win32") return;
        yield* Effect.promise(async () => {
          const sdk = await vi.importActual<typeof import("@muse-code/sdk")>("@muse-code/sdk");
          const processExited = pending<{ code: number | null; signal: NodeJS.Signals | null }>();
          const holderSource = `process.send("ready", () => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      });`;
          const fixture = `
        const { spawn } = require("node:child_process");
        require("node:readline").createInterface({ input: process.stdin }).on("line", async line => {
          const frame = JSON.parse(line);
          if (!("id" in frame)) return;
          let result = { schema: { version: 1, fingerprint: "t3-native-fixture" }, grantedCapabilities: [] };
          if (frame.method === "fixture/exit") {
            const holder = spawn(process.execPath, ["-e", ${JSON.stringify(holderSource)}], {
              detached: true, stdio: ["ignore", 1, 2, "ipc"]
            });
            await new Promise(resolve => holder.once("message", resolve));
            result = { pid: holder.pid };
          }
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }) + "\\n",
            () => { if (frame.method === "fixture/exit") process.exit(7); });
        });
      `;
          let holderPid: number | undefined;
          let host: MuseSdkHost | undefined;
          const reap = () => {
            if (holderPid !== undefined) {
              try {
                process.kill(holderPid, "SIGKILL");
              } catch {
                /* Already reaped. */
              }
              holderPid = undefined;
            }
          };
          onTestFinished(async () => {
            reap();
            await host?.close();
          });
          try {
            host = await createMuseSdkHost(
              {
                binaryPath: process.execPath,
                launch: { command: process.execPath, args: ["-e", fixture] },
                onProcessExit: processExited.resolve,
              },
              sdk.spawnMspConnection,
            );
            let sdkExited = false;
            let connectionClosed = false;
            void host.exited.then(() => {
              sdkExited = true;
            });
            void host.connection.closed.then(() => {
              connectionClosed = true;
            });
            const response = await host.connection.request("fixture/exit", {});
            expect(response).toMatchObject({ pid: expect.any(Number) });
            holderPid = Number((response as { pid: number }).pid);
            expect(await processExited.promise).toEqual({ code: 7, signal: null });
            expect(sdkExited).toBe(false);
            expect(connectionClosed).toBe(false);
            reap();
            expect(await host.exited).toEqual({ code: 7, signal: null });
            await host.close();
            expect(connectionClosed).toBe(true);
          } finally {
            reap();
            await host?.close();
          }
        });
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

  it.effect("runs an exe directly and a launcher script under cmd.exe on Windows", () =>
    Effect.gen(function* () {
      expect(yield* onWindows("C:\\Muse\\muse.exe")).toEqual({
        command: "C:\\Muse\\muse.exe",
        args: [],
      });
      const spaced = "C:\\Users\\Jane Doe\\AppData\\Local\\Programs\\muse\\muse.cmd";
      expect(yield* onWindows(spaced)).toEqual({ command: CMD, args: ["/d", "/c", "@", spaced] });
      const spacedAmpersand = "C:\\Users\\R&D Team\\AppData\\Local\\Programs\\muse\\muse.cmd";
      expect(yield* onWindows(spacedAmpersand)).toEqual({
        command: CMD,
        args: ["/d", "/c", "@", spacedAmpersand],
      });
      expect(yield* onWindows("C:\\Users\\R&D(1)\\muse.cmd")).toEqual({
        command: CMD,
        args: ["/d", "/c", "C:\\Users\\R^&D^(1^)\\muse.cmd"],
      });
      expect((yield* onWindows("C:\\Muse\\muse.bat", { SYSTEMROOT: "C:\\Windows" })).command).toBe(
        "C:\\Windows\\System32\\cmd.exe",
      );
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
});

describe("Muse workspace root", () => {
  it.effect("uses native canonical case off Windows", () =>
    Effect.gen(function* () {
      using _realpath = vi.spyOn(NodeFSP, "realpath").mockResolvedValue("/workspace/eevee");
      expect(yield* museWorkspaceRoot("/workspace/EEVEE")).toBe("/workspace/eevee");
    }).pipe(Effect.provideService(HostProcess.Platform, "darwin")),
  );

  it("writes Windows paths in their verbatim form", () => {
    expect(museVerbatimPath("C:\\Users\\Person\\repo")).toBe("\\\\?\\C:\\Users\\Person\\repo");
    expect(museVerbatimPath("\\\\server\\share\\repo")).toBe("\\\\?\\UNC\\server\\share\\repo");
    expect(museVerbatimPath("\\\\?\\C:\\repo")).toBe("\\\\?\\C:\\repo");
  });

  it.effect("keeps a root it cannot resolve off Windows", () =>
    Effect.gen(function* () {
      expect(yield* museWorkspaceRoot("/workspace/repo")).toBe("/workspace/repo");
    }).pipe(Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect("keeps a Windows root it cannot resolve, in verbatim form", () =>
    Effect.gen(function* () {
      expect(yield* museWorkspaceRoot("C:\\definitely-missing\\repo")).toBe(
        "\\\\?\\C:\\definitely-missing\\repo",
      );
      expect(yield* museWorkspaceRoot("C:/definitely-missing/repo")).toBe(
        "\\\\?\\C:\\definitely-missing\\repo",
      );
      expect(yield* museWorkspaceRoot("//server/share/missing")).toBe(
        "\\\\?\\UNC\\server\\share\\missing",
      );
    }).pipe(Effect.provideService(HostProcess.Platform, "win32")),
  );

  // FileSystem.realPath keeps the case it is given; Muse rejects a root whose case
  // differs from the disk's, and APFS is case-insensitive just like NTFS.
  it.effect("fixes the case of a macOS root natively", () =>
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) !== "darwin") return;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const created = yield* fs.makeTempDirectoryScoped({ prefix: "MuseRoot-" });
      // Only a case-insensitive volume resolves the miscased path; skip on a case-sensitive one.
      if (!(yield* fs.exists(created.toUpperCase()))) return;
      const root = yield* museWorkspaceRoot(created.toUpperCase());
      expect(path.basename(root)).toBe(path.basename(created));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

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
