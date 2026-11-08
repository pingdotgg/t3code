import * as NodePath from "@effect/platform-node/NodePath";
import * as TestClock from "effect/testing/TestClock";
import * as NodeEvents from "node:events";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as FileSystem from "effect/FileSystem";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { beforeEach, vi } from "vite-plus/test";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as ElectronUpdater from "./ElectronUpdater.ts";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  nativeInstall: vi.fn(),
  quit: vi.fn(),
  beforeQuit: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawn: mocks.spawn };
});
vi.mock("electron", () => ({
  app: { quit: mocks.quit },
  autoUpdater: { emit: mocks.beforeQuit },
}));
vi.mock("electron-updater", async () => {
  const NodeEvents = await import("node:events");
  return {
    autoUpdater: Object.assign(new NodeEvents.EventEmitter(), {
      channel: "nightly",
      quitAndInstall: mocks.nativeInstall,
    }),
  };
});

const installer = "/opt/T3 scripts/install-macos-update.sh";
const archive = "/cache/T3 update $(untouched).zip";
const helperPid = 42424;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.spawn.mockImplementation(() => {
    const child = Object.assign(new NodeEvents.EventEmitter(), {
      pid: helperPid,
      unref: vi.fn(),
      kill: vi.fn(),
      stdout: Object.assign(new NodeEvents.EventEmitter(), { destroy: vi.fn() }),
      stderr: Object.assign(new NodeEvents.EventEmitter(), { destroy: vi.fn() }),
    });
    queueMicrotask(() => child.stdout.emit("data", Buffer.from("ready\n")));
    return child;
  });
});

const install = (external: boolean, downloaded = true, platform: NodeJS.Platform = "darwin") =>
  Effect.scoped(
    Effect.gen(function* () {
      const updater = yield* ElectronUpdater.make;
      yield* updater.on("update-downloaded", () => {});
      if (downloaded) {
        const { autoUpdater } = yield* Effect.promise(() => import("electron-updater"));
        autoUpdater.emit("update-downloaded", {
          downloadedFile: archive,
          version: "1.2.4",
          files: [],
          path: archive,
          sha512: "verified-by-downloader",
          releaseDate: "2026-11-08T00:00:00Z",
        });
      }
      return yield* updater
        .quitAndInstall({ isSilent: true, isForceRunAfter: true })
        .pipe(Effect.result);
    }),
  ).pipe(
    Effect.provide(NodePath.layer),
    Effect.provideService(HostProcess.Platform, platform),
    Effect.provideService(
      HostProcess.ExecutablePath,
      "/Applications/T3 Code (Nightly).app/Contents/MacOS/T3 Code (Nightly)",
    ),
    Effect.provide(
      DesktopConfig.layerTest({ T3CODE_DESKTOP_UPDATE_INSTALLER: external ? installer : "" }),
    ),
  );

describe("ElectronUpdater install handoff", () => {
  it.effect("waits for complete helper readiness before quitting", () =>
    Effect.gen(function* () {
      const child = Object.assign(new NodeEvents.EventEmitter(), {
        unref: vi.fn(),
        kill: vi.fn(),
        stdout: Object.assign(new NodeEvents.EventEmitter(), { destroy: vi.fn() }),
        stderr: Object.assign(new NodeEvents.EventEmitter(), { destroy: vi.fn() }),
      });
      const started = new Promise<void>((resolveStarted) => {
        mocks.spawn.mockImplementation(() => {
          queueMicrotask(resolveStarted);
          return child;
        });
      });
      const fiber = yield* install(true).pipe(Effect.forkChild);
      yield* Effect.promise(() => started);
      assert.equal(mocks.quit.mock.calls.length, 0);
      child.stdout.emit("data", Buffer.from("rea"));
      yield* Effect.promise(() => Promise.resolve());
      assert.equal(mocks.quit.mock.calls.length, 0);
      child.stdout.emit("data", Buffer.from("dy\n"));
      assert.equal((yield* Fiber.join(fiber))._tag, "Success");
      assert.equal(mocks.quit.mock.calls.length, 1);
    }),
  );

  it.effect.each(["interrupt", "timeout"] as const)(
    "stops the unready helper on %s without quitting T3",
    (failure) =>
      Effect.gen(function* () {
        let markSignalled!: () => void;
        const signalled = new Promise<void>((resolve) => {
          markSignalled = resolve;
        });
        const child = Object.assign(new NodeEvents.EventEmitter(), {
          pid: helperPid,
          kill: vi.fn(markSignalled),
          stdout: Object.assign(new NodeEvents.EventEmitter(), { destroy: vi.fn() }),
          stderr: Object.assign(new NodeEvents.EventEmitter(), { destroy: vi.fn() }),
        });
        using signals = vi.spyOn(process, "kill").mockImplementation(() => {
          markSignalled();
          return true;
        });
        const started = new Promise<void>((resolveStarted) => {
          mocks.spawn.mockImplementation(() => {
            queueMicrotask(resolveStarted);
            return child;
          });
        });
        const fiber = yield* install(true).pipe(Effect.forkChild);
        yield* Effect.promise(() => started);
        const stopping = yield* (
          failure === "interrupt" ? Fiber.interrupt(fiber) : TestClock.adjust("120 seconds")
        ).pipe(Effect.forkChild);
        yield* Effect.promise(() => signalled);
        try {
          assert.deepEqual(signals.mock.calls, [[-helperPid, "SIGTERM"]]);
          assert.isUndefined(fiber.pollUnsafe(), "installation waits for its helper to close");
          child.emit("exit", null, "SIGTERM");
          yield* Effect.promise(() => Promise.resolve());
          assert.isUndefined(fiber.pollUnsafe(), "exit alone does not finish cleanup");
        } finally {
          child.emit("close", null, "SIGTERM");
        }
        yield* Fiber.join(stopping);
        if (failure === "timeout") assert.equal((yield* Fiber.join(fiber))._tag, "Failure");
        assert.equal(child.kill.mock.calls.length, 0);
        assert.equal(mocks.quit.mock.calls.length, 0);
        assert.equal(mocks.nativeInstall.mock.calls.length, 0);
      }),
  );

  it.effect.each(["linux", "win32"] as const)(
    "keeps the native installer on %s even when an external macOS installer is configured",
    (platform) =>
      Effect.gen(function* () {
        assert.equal((yield* install(true, true, platform))._tag, "Success");
        assert.equal(mocks.nativeInstall.mock.calls.length, 1);
        assert.equal(mocks.spawn.mock.calls.length, 0);
        assert.equal(mocks.quit.mock.calls.length, 0);
      }),
  );

  it.effect("keeps the native installer when no external installer is configured", () =>
    Effect.gen(function* () {
      assert.equal((yield* install(false))._tag, "Success");
      assert.equal(mocks.nativeInstall.mock.calls.length, 1);
      assert.equal(mocks.spawn.mock.calls.length, 0);
      assert.equal(mocks.quit.mock.calls.length, 0);
    }),
  );

  it.effect("hands the selected archive to one helper before allowing the update quit", () =>
    Effect.gen(function* () {
      const order: string[] = [];
      mocks.beforeQuit.mockImplementation(() => order.push("allow-quit"));
      mocks.quit.mockImplementation(() => order.push("quit"));
      assert.equal((yield* install(true))._tag, "Success");
      assert.deepEqual(mocks.spawn.mock.calls[0], [
        installer,
        [archive, "/Applications/T3 Code (Nightly).app", "1.2.4", String(process.pid), "true"],
        { detached: true, stdio: ["ignore", "pipe", "pipe"] },
      ]);
      assert.deepEqual(order, ["allow-quit", "quit"]);
      assert.equal(mocks.nativeInstall.mock.calls.length, 0);
    }),
  );

  it.effect.each([
    "missing-download",
    "spawn-failure",
    "helper-rejection",
    "invalid-readiness",
    "quit-failure",
    "before-quit-failure",
  ])("keeps T3 open without native fallback after %s", (failure) =>
    Effect.gen(function* () {
      using signals = vi.spyOn(process, "kill").mockImplementation(() => {
        queueMicrotask(() => mocks.spawn.mock.results[0]?.value.emit("close", null, "SIGTERM"));
        return true;
      });
      if (failure === "before-quit-failure")
        mocks.beforeQuit.mockImplementation(() => {
          throw new Error("quit gate rejected");
        });
      if (failure === "quit-failure")
        mocks.quit.mockImplementation(() => {
          throw new Error("quit rejected");
        });
      if (
        failure !== "missing-download" &&
        failure !== "quit-failure" &&
        failure !== "before-quit-failure"
      ) {
        mocks.spawn.mockImplementation(() => {
          const child = Object.assign(new NodeEvents.EventEmitter(), {
            pid: failure === "spawn-failure" ? undefined : helperPid,
            kill: vi.fn(),
            stdout: Object.assign(new NodeEvents.EventEmitter(), { destroy: vi.fn() }),
            stderr: Object.assign(new NodeEvents.EventEmitter(), { destroy: vi.fn() }),
          });
          queueMicrotask(() => {
            if (failure === "spawn-failure") {
              child.emit("error", new Error("cannot spawn installer"));
              child.emit("close", -1);
            }
            if (failure === "helper-rejection") {
              child.emit("exit", 1);
              child.stderr.emit("data", Buffer.from("invalid "));
              child.stderr.emit("data", Buffer.from("signature"));
              child.emit("close", 1);
            }
            if (failure === "invalid-readiness")
              child.stdout.emit("data", Buffer.from("unexpected\n"));
          });
          return child;
        });
      }
      const result = yield* install(true, failure !== "missing-download");
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "ElectronUpdaterQuitAndInstallError");
        assert.equal(
          result.failure.stage,
          failure === "missing-download"
            ? "validation"
            : failure === "quit-failure" || failure === "before-quit-failure"
              ? "shutdown"
              : "handoff",
        );
        if (failure === "helper-rejection")
          assert.equal((result.failure.cause as Error).message, "invalid signature");
      }
      assert.equal(mocks.quit.mock.calls.length, failure === "quit-failure" ? 1 : 0);
      assert.equal(
        mocks.beforeQuit.mock.calls.length,
        failure === "quit-failure" || failure === "before-quit-failure" ? 1 : 0,
      );
      assert.deepEqual(
        signals.mock.calls,
        ["invalid-readiness", "quit-failure", "before-quit-failure"].includes(failure)
          ? [[-helperPid, "SIGTERM"]]
          : [],
      );
      assert.equal(mocks.nativeInstall.mock.calls.length, 0);
    }),
  );
});

describe.runIf(HostProcess.Platform.defaultValue() !== "win32")("POSIX installer ownership", () => {
  it.live("reaps a foreground tool and runs shell cleanup before cancellation returns", () =>
    Effect.gen(function* () {
      const { spawn } = yield* Effect.promise(() =>
        vi.importActual<typeof import("node:child_process")>("node:child_process"),
      );
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "installer-group-" });
      yield* fs.writeFileString(`${root}/candidate`, "staged payload");
      yield* fs.writeFileString(`${root}/untouched`, "unrelated");
      let child: import("node:child_process").ChildProcess | undefined;
      let closed: Promise<void> | undefined;
      let didClose = false;
      const started = new Promise<number>((resolve, reject) => {
        mocks.spawn.mockImplementation(() => {
          child = spawn(
            "/bin/sh",
            [
              "-c",
              `set -eu
trap 'rm -f "$FIXTURE_ROOT/candidate"' EXIT
trap 'exit 1' TERM
/bin/sh -c 'printf "tool:%s\\n" "$$" >&2; exec /bin/sleep 60'
exit 0`,
            ],
            {
              detached: true,
              stdio: ["ignore", "pipe", "pipe"],
              env: { ...process.env, FIXTURE_ROOT: root },
            },
          );
          closed = new Promise<void>((resolveClosed) =>
            child!.once("close", () => {
              didClose = true;
              resolveClosed();
            }),
          );
          let output = "";
          child.stderr!.on("data", (chunk: Buffer) => {
            output += chunk.toString();
            const pid = /tool:(\d+)/.exec(output)?.[1];
            if (pid) resolve(Number(pid));
          });
          child.once("error", reject);
          return child;
        });
      });
      try {
        const fiber = yield* install(true).pipe(Effect.forkChild);
        const toolPid = yield* Effect.promise(() => started);
        assert.notEqual(toolPid, child!.pid, "fixture has a distinct foreground child");
        yield* Fiber.interrupt(fiber);
        assert.isTrue(didClose, "cancellation awaits its helper and foreground tool");
        assert.throws(() => process.kill(toolPid, 0), /ESRCH/);
        assert.isFalse(yield* fs.exists(`${root}/candidate`));
        assert.equal(yield* fs.readFileString(`${root}/untouched`), "unrelated");
        assert.equal(mocks.quit.mock.calls.length, 0);
      } finally {
        if (!didClose && child?.pid !== undefined) {
          yield* Effect.sync(() => {
            try {
              process.kill(-child!.pid!, "SIGTERM");
            } catch (cause) {
              if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH"))
                throw cause;
            }
          });
        }
        if (closed) yield* Effect.promise(() => closed!);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );
});
