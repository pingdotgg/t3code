import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { DEFAULT_TERMINAL_ID, ThreadId } from "@t3tools/contracts";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { expect, vi } from "vite-plus/test";

import * as ProcessRunner from "../processRunner.ts";
import { makeWithOptions } from "./Manager.ts";

const node = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);

it.layer(Layer.mergeAll(node, ProcessRunner.layer.pipe(Layer.provide(node))), {
  excludeTestServices: true,
})("TerminalManager clear", (it) => {
  it.effect.each([
    {
      part: "opener",
      publishing: "old output\r\n",
      queued: "\u001b]0;Build ",
      pending: "\u001b]0;Build ",
      afterClear: "progress\u0007ready\r\n",
    },
    {
      part: "CSI",
      publishing: "old output\r\n",
      queued: "\u001b[\n",
      pending: "\u001b[",
      afterClear: "mready\r\n",
    },
    {
      part: "terminator",
      publishing: "old output\r\n\u001b]0;Build ",
      queued: "progress\u0007",
      afterClear: "ready\r\n",
    },
    {
      part: "terminator before a legacy clear",
      publishing: "old output\r\n\u001b]0;Build ",
      queued: "progress\u0007",
      afterClear: "ready\r\n",
      legacy: true,
    },
    {
      part: "queued terminator followed by a split color command",
      publishing: "old output\r\n\u001b]0;Build ",
      queued: "progress\u0007\u001b[31",
      pending: "\u001b[31",
      legacyReplay: "\u001b[31",
      legacyOutput: "mready\r\n",
      afterClear: "mready\r\n",
      legacy: true,
    },
    {
      part: "queued replacement of a clipped color command",
      publishing: "old output\r\n\u001b[0000000032",
      queued: "m\u001b[31",
      pending: "\u001b[31",
      legacyReplay: "\u001b[31",
      legacyOutput: "mready\r\n",
      afterClear: "mready\r\n",
      legacy: true,
    },
    {
      part: "terminator after a legacy clear",
      publishing: "old output\r\n\u001b]0;Build ",
      queued: "in ",
      pending: "\u001b]0;Build in ",
      afterClear: "progress\u0007ready\r\n",
      legacy: true,
    },
    {
      part: "terminator still being published at legacy clear",
      publishing: "progress\u0007",
      queued: "",
      afterClear: "ready\r\n",
      legacy: true,
      prefix: "\u001b]0;Build ",
    },
    {
      part: "exit",
      publishing: "old output\r\n\u001b]0;Build ",
      queued: "progress\u0007",
      afterClear: "ready\r\n",
      exit: { exitCode: 42, signal: null },
    },
  ])("keeps visible history and output correct across clear ($part)", (row) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const logsDir = yield* fs.makeTempDirectoryScoped();
      const onData = vi.fn<(callback: (data: string) => void) => () => void>(() => () => {});
      const onExit = vi.fn<
        (callback: (event: { exitCode: number; signal: number | null }) => void) => () => void
      >(() => () => {});
      const manager = yield* makeWithOptions({
        logsDir,
        ptyAdapter: {
          spawn: () =>
            Effect.succeed({
              pid: 9000,
              write: () => {},
              resize: () => {},
              kill: () => {},
              onData,
              onExit,
            }),
        },
        foregroundProcessGroup: (pid) => Effect.succeed(pid),
        processKillGraceMs: 0,
      }).pipe(Effect.provideService(SpawnExecutableResolution, (command) => command));
      const input = { threadId: ThreadId.make("thread-1"), terminalId: DEFAULT_TERMINAL_ID };
      yield* manager.open({ ...input, cwd: logsDir });
      const live = yield* Stream.toPull(manager.attachOutputStream(input, "live"));
      yield* live;

      const publishing = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const printed = yield* Deferred.make<void>();
      yield* Effect.acquireRelease(
        manager.subscribe((event) => {
          if (event.type !== "output") return Effect.void;
          if (event.data === row.publishing) {
            return Deferred.succeed(publishing, undefined).pipe(
              Effect.andThen(Deferred.await(resume)),
            );
          }
          if (event.data === row.afterClear) return Deferred.succeed(printed, undefined);
          return Effect.void;
        }),
        (unsubscribe) =>
          Deferred.succeed(resume, undefined).pipe(Effect.andThen(Effect.sync(unsubscribe))),
      );
      const emitData = onData.mock.calls[0]![0];
      if (row.prefix) {
        emitData(row.prefix);
        yield* live;
      } else {
        emitData(row.publishing);
        yield* Deferred.await(publishing);
        yield* live;
      }
      const legacy = row.legacy
        ? yield* Stream.toPull(
            manager.attachOutputStream({ ...input, maxHistoryBytes: 8 }, "legacy"),
          )
        : undefined;
      if (legacy) {
        expect((yield* legacy)[0]).toMatchObject({ type: "snapshot", snapshot: { history: "" } });
      }
      if (row.prefix) {
        emitData(row.publishing);
        yield* Deferred.await(publishing);
        yield* live;
      }
      emitData(row.queued);
      if (row.exit) onExit.mock.calls[0]![0](row.exit);
      yield* manager.clear(input);
      const [cleared] = yield* live;
      expect(cleared?.type).toBe("cleared");
      if (legacy) {
        const [legacyClear] = yield* legacy;
        expect(legacyClear?.type).toBe("cleared");
        if (row.legacyReplay) {
          expect(legacyClear).toHaveProperty("pendingControlSequence", row.legacyReplay);
        } else {
          expect(legacyClear).not.toHaveProperty("pendingControlSequence");
        }
      }
      yield* Deferred.succeed(resume, undefined);

      if (row.exit) {
        emitData(row.afterClear);
        const [exited] = yield* live;
        expect(exited).toMatchObject({ type: "exited", exitCode: row.exit.exitCode });
        return;
      }
      if (row.pending) expect(cleared).toMatchObject({ pendingControlSequence: row.pending });
      emitData(row.afterClear);
      yield* Deferred.await(printed);
      if (legacy) {
        expect((yield* legacy)[0]).toMatchObject({
          type: "output",
          data: row.legacyOutput ?? "ready\r\n",
        });
      }

      const reopened = yield* Stream.toPull(manager.attachOutputStream(input, "reopened"));
      const [event] = yield* reopened;
      if (event?.type !== "snapshot") throw new Error("Expected a terminal snapshot");
      const visible = event.snapshot.history.replace(
        /\u001b\]0;[^\u0007]*\u0007|\u001b\[(?:31)?m/g,
        "",
      );
      expect(visible).toBe("ready\r\n");
    }),
  );
});
