import { assert, describe, it } from "@effect/vitest";
import type { ProviderReplayEntry } from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import { ChildProcess } from "effect/unstable/process";

import { PI_PROVIDER } from "./PiAdapterV2.ts";
import { PI_RPC_REPLAY_PROTOCOL, PiReplayController } from "./PiAdapterV2.testkit.ts";

const decodeLine = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const PI_COMMAND = ChildProcess.make("pi", ["--mode", "rpc"]);

const outbound = (frame: unknown): ProviderReplayEntry => ({ type: "expect_outbound", frame });
const inbound = (frame: unknown): ProviderReplayEntry => ({ type: "emit_inbound", frame });

const startReplay = (entries: ReadonlyArray<ProviderReplayEntry>) =>
  Effect.gen(function* () {
    const controller = new PiReplayController({
      provider: PI_PROVIDER,
      protocol: PI_RPC_REPLAY_PROTOCOL,
      version: "test",
      scenario: "testkit",
      entries: [outbound({ type: "process_start", args: ["--mode", "rpc"] }), ...entries],
    });
    const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
    const process = controller.spawn(PI_COMMAND, stdout);
    const readStdout = Queue.takeAll(stdout).pipe(
      Effect.map((chunks) =>
        [...chunks].flatMap((chunk) =>
          new TextDecoder()
            .decode(chunk)
            .split("\n")
            .filter((line) => line.length > 0)
            .map((line) => decodeLine(line)),
        ),
      ),
    );
    return { controller, process, readStdout };
  });

describe("PiAdapterV2 replay testkit", () => {
  it.effect("rebinds the adapter's request ids and replies with the id it sent", () =>
    Effect.gen(function* () {
      const replay = yield* startReplay([
        outbound({ type: "get_state", id: "t3-7" }),
        inbound({ type: "response", id: "t3-7", command: "get_state", success: true }),
      ]);
      replay.controller.receive(replay.process, { type: "get_state", id: "t3-0" });
      assert.deepEqual(yield* replay.readStdout, [
        { type: "response", id: "t3-0", command: "get_state", success: true },
      ]);
      replay.controller.assertComplete();
    }),
  );

  it.effect("keeps a Pi-issued id exact when the adapter echoes it", () =>
    Effect.gen(function* () {
      const replay = yield* startReplay([
        inbound({ type: "extension_ui_request", id: "ui-1", method: "confirm" }),
        outbound({ type: "extension_ui_response", id: "ui-1", confirmed: true }),
      ]);
      replay.controller.receive(replay.process, {
        type: "extension_ui_response",
        id: "ui-2",
        confirmed: true,
      });
      assert.throws(() => replay.controller.assertComplete(), /Pi replay mismatch/);
    }),
  );

  it.effect("tolerates reordered writes within a turn but not a write a turn early", () =>
    Effect.gen(function* () {
      const entries = [
        outbound({ type: "get_state", id: "t3-0" }),
        outbound({ type: "prompt", message: "one" }),
        inbound({ type: "response", id: "t3-0", command: "get_state", success: true }),
        inbound({ type: "agent_settled" }),
        outbound({ type: "prompt", message: "two" }),
        inbound({ type: "agent_settled" }),
      ];
      const reordered = yield* startReplay(entries);
      reordered.controller.receive(reordered.process, { type: "prompt", message: "one" });
      reordered.controller.receive(reordered.process, { type: "get_state", id: "t3-0" });
      reordered.controller.receive(reordered.process, { type: "prompt", message: "two" });
      reordered.controller.assertComplete();

      const early = yield* startReplay(entries);
      early.controller.receive(early.process, { type: "prompt", message: "two" });
      assert.throws(() => early.controller.assertComplete(), /Pi replay mismatch/);
    }),
  );
});
