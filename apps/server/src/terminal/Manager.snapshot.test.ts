import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { DEFAULT_TERMINAL_ID, type TerminalOpenInput } from "@t3tools/contracts";
import type { PtyProcess } from "@t3tools/shared/PtyAdapter";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { expect } from "vite-plus/test";

import * as ProcessRunner from "../processRunner.ts";
import * as TerminalManager from "./Manager.ts";

const nodeLayer = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);

it.layer(Layer.mergeAll(nodeLayer, ProcessRunner.layer.pipe(Layer.provide(nodeLayer))), {
  excludeTestServices: true,
})("Terminal snapshot replay", (it) => {
  it.effect.each([
    { name: "DEL padding", body: "31" + "\x7f".repeat(4_096) + "\r", replay: "31\r" },
    { name: "DLE padding", body: "31" + "\x10".repeat(4_096) + "\r", replay: "31\r" },
    { name: "non-ASCII padding", body: "31" + "é".repeat(4_096) + "\r", replay: "31\r" },
    { name: "over-budget parameters", body: "1".repeat(5_000) + "\r", replay: "\r" },
    { name: "repeated carriage returns", body: "31" + "\r".repeat(4_094), replay: "31\r" },
  ])("replays a split CSI with $name", ({ body, replay }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const logsDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-terminal-snapshot-" });
      let emitData: (data: string) => void = () => {
        throw new Error("PTY output listener is missing");
      };
      const pty: PtyProcess = {
        pid: 9000,
        write() {},
        resize() {},
        kill() {},
        onData(callback) {
          emitData = callback;
          return () => {};
        },
        onExit() {
          return () => {};
        },
      };
      const manager = yield* TerminalManager.makeWithOptions({
        logsDir,
        ptyAdapter: { spawn: () => Effect.succeed(pty) },
        foregroundProcessGroup: (pid) => Effect.succeed(pid),
        processKillGraceMs: 1,
      }).pipe(Effect.provideService(SpawnExecutableResolution, (command) => command));
      const input: TerminalOpenInput = {
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        cwd: process.cwd(),
        cols: 100,
        rows: 24,
      };
      const live = yield* Stream.toPull(manager.attachOutputStream(input, "live"));
      yield* live;
      emitData("prompt\u001b[" + body);
      yield* live;

      const joining = yield* Stream.toPull(manager.attachOutputStream(input, "joining"));
      const [snapshot] = yield* joining;
      if (snapshot?.type !== "snapshot") throw new Error("Expected a terminal snapshot");
      emitData("mX");
      const [output] = yield* joining;
      if (output?.type !== "output") throw new Error("Expected live terminal output");

      expect(snapshot.snapshot.history + output.data).toBe("prompt\u001b[" + replay + "mX");
    }),
  );
});
