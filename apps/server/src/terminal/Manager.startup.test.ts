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
          spawn: () =>
            Effect.gen(function* () {
              if (pauseSpawn) {
                pauseSpawn = false;
                yield* Effect.interruptible(pause);
              }
              const fiber = yield* Effect.withFiberSucceed((fiber) => fiber);
              const process: PtyAdapter.PtyProcess = {
                pid: nextPid++,
                onData: () => () => {},
                onExit: (listener) => {
                  emitExit ??= listener;
                  if (cancelAtRegistration) {
                    listener({ exitCode: 7, signal: 0 });
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
      if (
        scenario === "exited reopen" ||
        scenario === "capacity pressure" ||
        cancelAtRegistration
      ) {
        const stop = yield* manager.subscribe((event) =>
          event.type === "exited"
            ? Deferred.succeed(exited, undefined).pipe(Effect.asVoid)
            : Effect.void,
        );
        yield* Effect.addFinalizer(() => Effect.sync(stop));
      }
      if (!pauseSpawn && !cancelAtAcquisition && !cancelAtRegistration) yield* manager.open(input);

      const viewerEvents: TerminalAttachStreamEvent[] = [];
      if (scenario === "canceled reopen") {
        const stop = yield* manager.attachStream({ ...input, resume: true }, (event) =>
          Effect.sync(() => {
            viewerEvents.push(event);
          }),
        );
        yield* Effect.addFinalizer(() => Effect.sync(stop));
        pauseSpawn = true;
      }

      if (scenario === "exited reopen") {
        emitExit?.({ exitCode: 0, signal: 0 });
        yield* Deferred.await(exited);
        pauseHistoryWrite = true;
      }

      const reopen =
        scenario === "changed launch context" || scenario === "canceled reopen"
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

      if (scenario === "canceled reopen") {
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
      } else if (cancelAtAcquisition || cancelAtRegistration) {
        yield* Fiber.await(pending);
        if (cancelAtRegistration) yield* Deferred.await(exited);
        expect(yield* attachEvents(reopen)).toMatchObject([
          {
            type: "snapshot",
            snapshot: { status: "exited", exitCode: cancelAtRegistration ? 7 : null },
          },
        ]);
        if (cancelAtAcquisition) yield* Deferred.await(killed);
        else expect(yield* Deferred.isDone(killed)).toBe(false);
        return;
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
