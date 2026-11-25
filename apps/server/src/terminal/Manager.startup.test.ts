import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { DEFAULT_TERMINAL_ID, type TerminalSessionSnapshot } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type { PtyExitEvent, PtyProcess } from "@t3tools/shared/PtyAdapter";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";
import * as ProcessRunner from "../processRunner.ts";
import { makeWithOptions } from "./Manager.ts";

const node = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);
const services = Layer.mergeAll(node, ProcessRunner.layer.pipe(Layer.provide(node)));

function fakePtyProcess(): PtyProcess {
  const exitListeners = new Set<(event: PtyExitEvent) => void>();
  return {
    pid: 42,
    write: () => {},
    resize: () => {},
    kill: () => {
      for (const listener of exitListeners) listener({ exitCode: 0, signal: null });
    },
    onData: () => () => {},
    onExit: (listener) => {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
  };
}

it.layer(services, { excludeTestServices: true })("terminal startup deadlines", (it) => {
  it.effect.each([
    { name: "reports a timeout when no shell resolves", stalled: "lookup", fallback: false },
    { name: "starts a fallback shell after a lookup stalls", stalled: "lookup", fallback: true },
    {
      name: "keeps the original PATH when the managed scan stalls",
      stalled: "scan",
      fallback: true,
    },
  ] as const)("$name", ({ stalled, fallback }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-terminal-startup-" });
      const cacheDir = path.join(cwd, "cache");
      const receiptsDir = path.join(cacheDir, "acp-registry", "package-installs");
      const waiting = yield* Deferred.make<void>();
      const spawned: Array<{ shell: string; path: string | undefined }> = [];
      let lookupRecovered = false;
      const manager = yield* makeWithOptions({
        logsDir: path.join(cwd, "logs"),
        env: { PATH: "/usr/bin" },
        shellResolver: () => "local-shell",
        ...(stalled === "scan"
          ? { managedBinaryCacheDir: cacheDir, managedBinaryToolsDir: path.join(cwd, "tools") }
          : {}),
        ptyAdapter: {
          spawn: (input) =>
            Effect.sync(() => {
              spawned.push({ shell: input.shell, path: input.env.PATH });
              return fakePtyProcess();
            }),
        },
      }).pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(SpawnExecutableResolution, (command) => {
          if (stalled === "lookup" && command === "stalled-shell" && !lookupRecovered) {
            Deferred.doneUnsafe(waiting, Effect.void);
            return new Promise(() => {});
          }
          return command === "local-shell" && (fallback || lookupRecovered) ? command : undefined;
        }),
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          readDirectory: (directory, options) =>
            stalled === "scan" && directory === receiptsDir
              ? Deferred.succeed(waiting, undefined).pipe(Effect.andThen(Effect.never))
              : fs.readDirectory(directory, options),
        }),
      );

      const input = {
        cwd,
        threadId: "thread",
        terminalId: DEFAULT_TERMINAL_ID,
        ...(stalled === "lookup" ? { env: { T3CODE_TERMINAL_SHELL: "stalled-shell" } } : {}),
      };
      const opening = yield* manager.open(input).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(waiting);
      const disconnect = yield* Fiber.interrupt(opening).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust("16 seconds");
      yield* Fiber.join(disconnect);

      const snapshots: TerminalSessionSnapshot[] = [];
      const stop = yield* manager.attachStream(input, (event) =>
        Effect.sync(() => {
          if (event.type === "snapshot") snapshots.push(event.snapshot);
        }),
      );
      stop();

      if (fallback) {
        expect(snapshots).toEqual([expect.objectContaining({ status: "running" })]);
        expect(spawned).toEqual([{ shell: "local-shell", path: "/usr/bin" }]);
      } else {
        expect(snapshots).toEqual([
          expect.objectContaining({
            status: "error",
            error: "Terminal shell preparation timed out.",
          }),
        ]);
        expect(spawned).toEqual([]);
        lookupRecovered = true;
        expect((yield* manager.open(input)).status).toBe("running");
      }
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
