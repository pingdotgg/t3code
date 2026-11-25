import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
  DEFAULT_TERMINAL_ID,
  TerminalAttachStreamEvent,
  terminalSequenceEnd,
  terminalSequenceStateAfter,
} from "@t3tools/contracts";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { expect } from "vite-plus/test";

import * as ProcessRunner from "../processRunner.ts";
import { makeWithOptions } from "./Manager.ts";
import { terminalOutputStream } from "./OutputProtocol.ts";

const platform = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);
const wireEvent = Schema.fromJsonString(TerminalAttachStreamEvent);

it.layer(Layer.mergeAll(platform, ProcessRunner.layer.pipe(Layer.provide(platform))), {
  excludeTestServices: true,
})("terminal snapshot wire replay", (it) => {
  it.effect.each([
    {
      name: "title with no history budget",
      pending: "\u001b]0;Build ",
      tail: "progress\u0007",
      budget: 0,
      history: "",
      viewer: "attach",
      supportsSnapshotSequenceState: true,
    },
    {
      name: "CSI beyond the pending prefix limit",
      pending: "\u001b[" + "\u007f".repeat(4_096) + "20",
      tail: "C",
      budget: DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
      history: "before\r\n",
      viewer: "attach",
      supportsSnapshotSequenceState: true,
    },
    ...(["attach", "observe", "resync"] as const).map((viewer) => ({
      name: `long title for a legacy ${viewer} viewer`,
      pending: "\u001b]0;" + "x".repeat(4_096),
      tail: "progress\u0007",
      budget: DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
      history: "before\r\n\u001b]",
      viewer,
      supportsSnapshotSequenceState: false,
    })),
  ] as const)(
    "keeps $name out of visible output",
    ({ pending, tail, budget, history, viewer, supportsSnapshotSequenceState }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const logsDir = yield* fs.makeTempDirectoryScoped({ prefix: "terminal-snapshot-" });
        let emit: ((data: string) => void) | undefined;
        const manager = yield* makeWithOptions({
          logsDir,
          ptyAdapter: {
            spawn: () =>
              Effect.succeed({
                pid: 9_000,
                write: () => {},
                resize: () => {},
                kill: () => {},
                onData: (listener) => {
                  emit = listener;
                  return () => {
                    emit = undefined;
                  };
                },
                onExit: () => () => {},
              }),
          },
          foregroundProcessGroup: (pid) => Effect.succeed(pid),
        }).pipe(Effect.provideService(SpawnExecutableResolution, (command) => command));
        const input = { threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID, cwd: logsDir };
        const live = yield* Stream.toPull(manager.attachOutputStream(input, "live"));
        yield* live;
        if (emit === undefined) throw new Error("Expected a PTY output listener");
        emit("before\r\n" + pending);
        yield* live;

        const viewerInput = supportsSnapshotSequenceState
          ? { ...input, supportsSnapshotSequenceState: true }
          : input;
        const joining = yield* Stream.toPull(
          viewer === "attach"
            ? manager.attachOutputStream({ ...viewerInput, maxHistoryBytes: budget }, "joining")
            : terminalOutputStream((listener, cleanup) =>
                viewer === "observe"
                  ? manager.observeStream(viewerInput, listener, cleanup)
                  : manager.resyncStream(viewerInput, listener, cleanup),
              ),
        );
        const [snapshot] = yield* joining;
        if (snapshot?.type !== "snapshot") throw new Error("Expected a terminal snapshot");
        const encoded = yield* Schema.encodeEffect(wireEvent)(snapshot);
        const decoded = yield* Schema.decodeEffect(wireEvent)(encoded);
        if (decoded.type !== "snapshot") throw new Error("Expected a terminal snapshot");
        expect(decoded.snapshot.history).toBe(history);
        const omitted = decoded.snapshot.historySequenceState;
        if (supportsSnapshotSequenceState) {
          expect(omitted).toBeDefined();
        } else {
          expect(omitted).toBeUndefined();
        }
        const state = omitted ?? terminalSequenceStateAfter(0, decoded.snapshot.history);

        emit(tail + "ready");
        const [output] = yield* joining;
        if (output?.type !== "output") throw new Error("Expected terminal output");
        expect(output.data.slice(terminalSequenceEnd(state, output.data))).toBe("ready");
      }),
  );
});
