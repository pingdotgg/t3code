import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  DEFAULT_TERMINAL_ID,
  type TerminalAttachStreamEvent,
  type TerminalOpenInput,
} from "@t3tools/contracts";
import type * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { expect } from "vite-plus/test";
import * as ProcessRunner from "../processRunner.ts";
import * as TerminalManager from "./Manager.ts";

it.layer(
  Layer.mergeAll(
    NodeServices.layer,
    NodeCrypto.layer,
    ProcessRunner.layer.pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  ),
  { excludeTestServices: true },
)("terminal startup retention", (it) => {
  it.effect.each([
    { scenario: "canceled reopen", limit: 1 },
    { scenario: "canceled history write", limit: 1 },
    { scenario: "canceled acquisition", limit: 1 },
    { scenario: "canceled registration", limit: 1 },
    { scenario: "exited reopen", limit: 1 },
    { scenario: "changed launch context", limit: 0 },
    { scenario: "capacity pressure", limit: 2 },
  ] as const)("keeps the terminal recoverable after $scenario", ({ scenario, limit }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const logsDir = yield* fs.makeTempDirectoryScoped();
      const paused = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const pause = Deferred.succeed(paused, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      const exited = yield* Deferred.make<void>();
      let emitExit: ((event: PtyAdapter.PtyExitEvent) => void) | undefined;
      let nextPid = 9000;
      let pauseSpawn = scenario === "capacity pressure";
      const cancelAtAcquisition = scenario === "canceled acquisition";
      const cancelAtRegistration = scenario === "canceled registration";
      const cancelAtHistory = scenario === "canceled history write";
      let emitOutput: ((data: string) => void) | undefined;
      const outputDelivered = yield* Deferred.make<void>();
      const killed = yield* Deferred.make<void>();
      let pauseHistoryWrite = false;
      const manager = yield* TerminalManager.makeWithOptions({
        logsDir,
        historyLineLimit: 5,
        shellResolver: () => "/bin/sh",
        foregroundProcessGroup: (pid) => Effect.succeed(pid),
        processKillGraceMs: 1,
        maxRetainedInactiveSessions: limit,
        ptyAdapter: {
          spawn: ({ onSpawned }) =>
            Effect.gen(function* () {
              if (pauseSpawn) {
                pauseSpawn = false;
                yield* pause;
              }
              const fiber = yield* Effect.withFiberSucceed((fiber) => fiber);
              const process: PtyAdapter.PtyProcess = {
                pid: nextPid++,
                onData: (listener) => {
                  emitOutput = listener;
                  return () => {};
                },
                onExit: (listener) => {
                  emitExit ??= listener;
                  if (cancelAtRegistration && process.pid !== 9000) {
                    fiber.interruptUnsafe();
                  }
                  return () => {};
                },
                write: () => {},
                resize: () => {},
                kill: () => {
                  Deferred.doneUnsafe(killed, Effect.void);
                },
              };
              onSpawned?.(process);
              if (cancelAtAcquisition && process.pid === 9000) fiber.interruptUnsafe();
              return process;
            }),
        },
      }).pipe(
        Effect.provideService(SpawnExecutableResolution, (command) => command),
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          writeFileString: (path, data, options) =>
            Effect.gen(function* () {
              if (pauseHistoryWrite) {
                pauseHistoryWrite = false;
                yield* pause;
              }
              yield* fs.writeFileString(path, data, options);
            }),
        }),
      );

      const input: TerminalOpenInput = {
        threadId: "first",
        terminalId: DEFAULT_TERMINAL_ID,
        cwd: process.cwd(),
      };
      if (scenario === "exited reopen" || scenario === "capacity pressure") {
        const stop = yield* manager.subscribe((event) =>
          event.type === "exited"
            ? Deferred.succeed(exited, undefined).pipe(Effect.asVoid)
            : Effect.void,
        );
        yield* Effect.addFinalizer(() => Effect.sync(stop));
      }
      if (!pauseSpawn && !cancelAtAcquisition) yield* manager.open(input);

      const viewerEvents: TerminalAttachStreamEvent[] = [];
      if (scenario === "canceled reopen" || cancelAtHistory || cancelAtRegistration) {
        const stop = yield* manager.attachStream({ ...input, resume: true }, (event) =>
          Effect.sync(() => {
            viewerEvents.push(event);
            if (event.type === "output") Deferred.doneUnsafe(outputDelivered, Effect.void);
          }),
        );
        yield* Effect.addFinalizer(() => Effect.sync(stop));
        pauseSpawn = scenario === "canceled reopen";
        pauseHistoryWrite = cancelAtHistory;
      }

      if (scenario === "exited reopen") {
        emitExit?.({ exitCode: 0, signal: 0 });
        yield* Deferred.await(exited);
        pauseHistoryWrite = true;
      }

      const reopen =
        scenario === "changed launch context" ||
        scenario === "canceled reopen" ||
        cancelAtHistory ||
        cancelAtRegistration
          ? { ...input, cwd: logsDir }
          : input;
      const pending = yield* manager.open(reopen).pipe(Effect.forkChild());
      const second = { ...input, threadId: "second", cwd: logsDir };
      const attachEvents = (target: TerminalOpenInput) =>
        Effect.gen(function* () {
          const events: TerminalAttachStreamEvent[] = [];
          const stop = yield* manager.attachStream({ ...target, resume: true }, (event) =>
            Effect.sync(() => {
              events.push(event);
            }),
          );
          yield* Effect.addFinalizer(() => Effect.sync(stop));
          return events;
        });

      if (scenario === "canceled reopen" || cancelAtHistory) {
        yield* Deferred.await(paused);
        yield* Fiber.interrupt(pending);
        expect(viewerEvents).toMatchObject([
          { type: "snapshot", snapshot: { status: "running" } },
          { type: "exited", exitCode: null },
        ]);
        expect(yield* attachEvents(reopen)).toMatchObject([
          { type: "snapshot", snapshot: { status: "exited" } },
        ]);
        yield* manager.open(reopen);
      } else if (cancelAtAcquisition) {
        yield* Fiber.await(pending);
        expect(yield* attachEvents(reopen)).toMatchObject([
          { type: "snapshot", snapshot: { status: "exited", exitCode: null } },
        ]);
        yield* Deferred.await(killed);
        return;
      } else if (cancelAtRegistration) {
        yield* Fiber.await(pending);
        emitOutput?.("still running");
        yield* Deferred.await(outputDelivered);
        expect(viewerEvents.filter((event) => event.type !== "activity")).toMatchObject([
          { type: "snapshot", snapshot: { status: "running", pid: 9000 } },
          { type: "started", snapshot: { status: "running", pid: 9001 } },
          { type: "output", data: "still running" },
        ]);
      } else if (scenario === "exited reopen") {
        yield* Deferred.await(paused);
        yield* manager.open(second);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(pending);
      } else if (scenario === "capacity pressure") {
        yield* Deferred.await(paused);
        yield* manager.open(second);
        emitExit?.({ exitCode: 0, signal: 0 });
        yield* Deferred.await(exited);
        yield* manager.open({ ...second, threadId: "third" });
        expect(yield* attachEvents(second)).toMatchObject([{ type: "closed" }]);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(pending);
      } else {
        yield* Fiber.join(pending);
      }

      expect(yield* attachEvents(reopen)).toMatchObject([
        { type: "snapshot", snapshot: { status: "running" } },
      ]);
    }),
  );
});
