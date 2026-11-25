import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  DEFAULT_TERMINAL_ID,
  ThreadId,
  type TerminalAttachStreamEvent,
  type TerminalEvent,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { expect } from "vite-plus/test";
import * as ProcessRunner from "../processRunner.ts";
import * as TerminalManager from "./Manager.ts";

const nodeLayer = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);

it.layer(Layer.mergeAll(nodeLayer, ProcessRunner.layer.pipe(Layer.provide(nodeLayer))), {
  excludeTestServices: true,
})("TerminalManager startup cancellation", (it) => {
  it.effect.each(["spawning", "publishing"] as const)(
    "reports interrupted startup while %s",
    (stage) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped();
        const reachedStage = yield* Deferred.make<void>();
        const killed = yield* Deferred.make<void>();
        const pause = Deferred.succeed(reachedStage, undefined).pipe(Effect.andThen(Effect.never));
        const manager = yield* TerminalManager.makeWithOptions({
          logsDir: cwd,
          shellResolver: () => "cmd.exe",
          ptyAdapter: {
            spawn: () =>
              stage === "spawning"
                ? pause
                : Effect.succeed({
                    pid: 9000,
                    write: () => {},
                    resize: () => {},
                    onData: () => () => {},
                    onExit: () => () => {},
                    kill: () => Deferred.doneUnsafe(killed, Effect.void),
                  }),
          },
          foregroundProcessGroup: (pid) => Effect.succeed(pid),
        }).pipe(Effect.provideService(HostProcess.Platform, "win32"));

        const input = { cwd, threadId: ThreadId.make("thread"), terminalId: DEFAULT_TERMINAL_ID };
        const events: TerminalEvent[] = [];
        const unsubscribe = yield* manager.subscribe((event) => {
          events.push(event);
          return stage === "publishing" && event.type === "started" ? pause : Effect.void;
        });
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

        const opening = yield* manager.open(input).pipe(Effect.forkChild());
        yield* Deferred.await(reachedStage);
        yield* Fiber.interrupt(opening);

        const snapshots: TerminalAttachStreamEvent[] = [];
        const stop = yield* manager.attachStream(input, (event) =>
          Effect.sync(() => {
            snapshots.push(event);
          }),
        );
        yield* Effect.addFinalizer(() => Effect.sync(stop));

        expect(snapshots).toMatchObject([
          {
            type: "snapshot",
            snapshot: { status: "error", error: "Terminal startup was interrupted." },
          },
        ]);
        expect(events.filter((event) => event.type === "error")).toMatchObject([
          {
            threadId: input.threadId,
            terminalId: input.terminalId,
            message: "Terminal startup was interrupted.",
          },
        ]);
        if (stage === "publishing") yield* Deferred.await(killed);
      }),
  );
});
