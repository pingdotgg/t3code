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
  makeTempDirectory: vi.fn(),
  remove: vi.fn(),
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
const ownedStage = "/Applications/.t3-update.fixture";
const makeChild = (pid: number | undefined) =>
  Object.assign(new NodeEvents.EventEmitter(), {
    pid,
    unref: vi.fn(),
    kill: vi.fn(),
    stdout: Object.assign(new NodeEvents.EventEmitter(), { destroy: vi.fn() }),
    stderr: Object.assign(new NodeEvents.EventEmitter(), { destroy: vi.fn() }),
  });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.makeTempDirectory.mockImplementation(() => Effect.succeed(ownedStage));
  mocks.remove.mockImplementation(() => Effect.void);
  mocks.spawn.mockImplementation(() => {
    const child = makeChild(helperPid);
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
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        makeTempDirectory: (options) => mocks.makeTempDirectory(options),
        remove: (path, options) => mocks.remove(path, options),
      }),
    ),
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
      const child = makeChild(helperPid);
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
        const child = makeChild(helperPid);
        child.kill.mockImplementation(markSignalled);
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

  it.effect.each(["ignores-term", "held-pipe", "spawn-error", "missing-exit"] as const)(
    "bounds cleanup for %s without waiting indefinitely for close",
    (mode) =>
      Effect.gen(function* () {
        let markTerm!: () => void;
        const termSent = new Promise<void>((resolve) => {
          markTerm = resolve;
        });
        const child = makeChild(mode === "spawn-error" ? undefined : helperPid);
        using signals = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
          if (signal === "SIGTERM") {
            if (mode === "held-pipe") child.emit("exit", 1);
            markTerm();
          }
          return true;
        });
        const started = new Promise<void>((resolve) =>
          mocks.spawn.mockImplementation(() => {
            queueMicrotask(() => {
              if (mode === "spawn-error")
                child.emit("error", Object.assign(new Error("no descriptors"), { code: "EMFILE" }));
              resolve();
            });
            return child;
          }),
        );
        const fiber = yield* install(true).pipe(Effect.forkChild);
        yield* Effect.promise(() => started);
        const stopping =
          mode === "spawn-error" ? undefined : yield* Fiber.interrupt(fiber).pipe(Effect.forkChild);
        if (mode !== "spawn-error") yield* Effect.promise(() => termSent);
        yield* TestClock.adjust("5 seconds");
        try {
          if (mode === "spawn-error") {
            assert.isDefined(fiber.pollUnsafe(), "a failed spawn has no process to reap");
            assert.deepEqual(signals.mock.calls, []);
          } else {
            assert.deepEqual(signals.mock.calls, [
              [-helperPid, "SIGTERM"],
              [-helperPid, "SIGKILL"],
            ]);
            if (mode === "ignores-term") {
              assert.isUndefined(fiber.pollUnsafe(), "escalation still waits for helper exit");
              child.emit("exit", null, "SIGKILL");
            }
            if (mode === "missing-exit") {
              yield* TestClock.adjust("5 seconds");
              assert.isDefined(
                fiber.pollUnsafe(),
                "a missing exit event cannot block cleanup forever",
              );
            }
            yield* Fiber.join(stopping!);
            assert.equal(child.stdout.destroy.mock.calls.length, 1);
            assert.equal(child.stderr.destroy.mock.calls.length, 1);
          }
          assert.equal(mocks.quit.mock.calls.length, 0);
          assert.equal(mocks.nativeInstall.mock.calls.length, 0);
          assert.deepEqual(
            mocks.remove.mock.calls,
            mode === "missing-exit"
              ? []
              : [
                  [`${ownedStage}/candidate.app`, { recursive: true, force: true }],
                  [`${ownedStage}/extracted`, { recursive: true, force: true }],
                ],
          );
        } finally {
          child.emit("exit", 1);
          child.emit("close", 1);
        }
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
      const [command, args, options] = mocks.spawn.mock.calls[0]!;
      assert.equal(command, installer);
      assert.deepEqual(args, [
        archive,
        "/Applications/T3 Code (Nightly).app",
        "1.2.4",
        String(process.pid),
        "true",
      ]);
      assert.equal(options.detached, true);
      assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
      assert.equal(options.env?.T3CODE_DESKTOP_UPDATE_STAGE, ownedStage);
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
          const child = makeChild(failure === "spawn-failure" ? undefined : helperPid);
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
  it.live.each(["graceful", "forced"] as const)(
    "reaps a %s helper group and cleans its owned stage",
    (mode) =>
      Effect.gen(function* () {
        const { spawn, spawnSync } = yield* Effect.promise(() =>
          vi.importActual<typeof import("node:child_process")>("node:child_process"),
        );
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "installer-group-" });
        yield* fs.writeFileString(`${root}/untouched`, "unrelated");
        let stageDirectory = "";
        mocks.makeTempDirectory.mockImplementation(() =>
          fs.makeTempDirectory({ directory: root, prefix: ".t3-update." }).pipe(
            Effect.map((dir) => {
              stageDirectory = dir;
              return dir;
            }),
          ),
        );
        mocks.remove.mockImplementation((path, options) => fs.remove(path, options));
        let child: import("node:child_process").ChildProcess | undefined;
        let closed: Promise<void> | undefined;
        let didClose = false;
        const started = new Promise<number>((resolve, reject) => {
          mocks.spawn.mockImplementation((_command, _args, options) => {
            child = spawn(
              "/bin/sh",
              [
                "-c",
                `set -eu
stage=$T3CODE_DESKTOP_UPDATE_STAGE
mkdir "$stage/candidate.app" "$stage/extracted"
printf diagnostic > "$stage/install.log"
printf rollback > "$stage/previous.app"
printf rejected > "$stage/failed.app"
trap 'rm -rf "$stage/candidate.app" "$stage/extracted"' EXIT
if [ "$FIXTURE_FORCE" = 1 ]; then trap '' TERM; else trap 'exit 1' TERM; fi
/bin/sh -c 'if [ "$FIXTURE_FORCE" = 1 ]; then trap "" TERM; fi; printf "tool:%s\\n" "$$" >&2; exec /bin/sleep 60'
exit 0`,
              ],
              {
                detached: true,
                stdio: ["ignore", "pipe", "pipe"],
                env: {
                  PATH: "/usr/bin:/bin",
                  T3CODE_DESKTOP_UPDATE_STAGE: options.env.T3CODE_DESKTOP_UPDATE_STAGE,
                  FIXTURE_FORCE: mode === "forced" ? "1" : "0",
                },
              },
            );
            closed = new Promise<void>((done) =>
              child!.once("close", () => {
                didClose = true;
                done();
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
          if (closed) yield* Effect.promise(() => closed!);
          assert.isTrue(didClose, "helper has terminated");
          const tool = spawnSync("/bin/ps", ["-o", "stat=", "-p", String(toolPid)], {
            encoding: "utf8",
          });
          assert.isTrue(
            tool.status === 1 || /^\s*Z/.test(tool.stdout),
            "foreground child is gone or awaiting OS reaping",
          );
          assert.isFalse(yield* fs.exists(`${stageDirectory}/candidate.app`));
          assert.isFalse(yield* fs.exists(`${stageDirectory}/extracted`));
          assert.equal(yield* fs.readFileString(`${stageDirectory}/install.log`), "diagnostic");
          assert.equal(yield* fs.readFileString(`${stageDirectory}/previous.app`), "rollback");
          assert.equal(yield* fs.readFileString(`${stageDirectory}/failed.app`), "rejected");
          assert.equal(yield* fs.readFileString(`${root}/untouched`), "unrelated");
          assert.equal(mocks.quit.mock.calls.length, 0);
        } finally {
          if (!didClose && child?.pid !== undefined)
            yield* Effect.sync(() => {
              try {
                process.kill(-child!.pid!, "SIGKILL");
              } catch (cause) {
                if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH"))
                  throw cause;
              }
            });
          if (closed) yield* Effect.promise(() => closed!);
        }
      }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );
});
