import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { AntigravitySettings, ThreadId } from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { makeAntigravityAdapter } from "./AntigravityAdapter.ts";

const decodeAntigravitySettings = Schema.decodeSync(AntigravitySettings);

const asThreadId = (id: string): ThreadId => ThreadId.make(id);

const AntigravityAdapterTestLayer = ServerConfig.layerTest(process.cwd(), process.cwd()).pipe(
  Layer.provideMerge(NodeServices.layer),
);

it.layer(AntigravityAdapterTestLayer)("AntigravityAdapter", (it) => {
  it.effect("starts and tracks sessions", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-agy-adapter-" });
        const adapter = yield* makeAntigravityAdapter(decodeAntigravitySettings({}));

        const threadId = asThreadId("thread-agy-1");
        const session = yield* adapter.startSession({
          threadId,
          cwd: dir,
          runtimeMode: "full-access",
        });

        expect(session.provider).toBe("antigravity");
        expect(session.threadId).toBe(threadId);
        expect(yield* adapter.hasSession(threadId)).toBe(true);

        const sessions = yield* adapter.listSessions();
        expect(sessions.some((s) => s.threadId === threadId)).toBe(true);

        yield* adapter.stopSession(threadId);
        expect(yield* adapter.hasSession(threadId)).toBe(false);
      }),
    ),
  );

  it.effect("parses stream-json output and emits runtime events during a turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-agy-turn-" });
        const stubScript = path.join(dir, "agy-stub.sh");

        const stubEvents = [
          '{"event":"init","conversation_id":"conv-12345","init":{"cwd":"' +
            dir +
            '","tools":["run_command","view_file"]}}',
          '{"event":"step_update","step_update":{"conversation_id":"conv-12345","step_index":0,"state":"ACTIVE","step_type":"agent_response","text_delta":"Hello from Antigravity!","usage":{"input_tokens":100,"output_tokens":20,"thinking_tokens":10,"total_tokens":130}}}',
          '{"event":"step_update","step_update":{"conversation_id":"conv-12345","step_index":1,"state":"ACTIVE","step_type":"tool","tool_name":"view_file","tool_info":{"name":"view_file","parameters":{"AbsolutePath":"/tmp/foo.txt"}}}}',
          '{"event":"step_update","step_update":{"conversation_id":"conv-12345","step_index":1,"state":"DONE","step_type":"tool","tool_name":"view_file","tool_info":{"name":"view_file","output":"file content"}}}',
          '{"event":"result","result":{"conversation_id":"conv-12345","status":"SUCCESS","response":"Hello from Antigravity!","usage":{"input_tokens":100,"output_tokens":20,"thinking_tokens":10,"total_tokens":130}}}',
        ];

        yield* fs.writeFileString(
          stubScript,
          ["#!/bin/sh", ...stubEvents.map((e) => `printf '%s\\n' '${e}'`), "exit 0", ""].join("\n"),
        );
        yield* fs.chmod(stubScript, 0o755);
        const adapter = yield* makeAntigravityAdapter(
          decodeAntigravitySettings({ binaryPath: stubScript }),
        );

        const eventsFiber = yield* Stream.runCollect(
          adapter.streamEvents.pipe(Stream.takeUntil((e) => e.type === "turn.completed")),
        ).pipe(Effect.forkChild);

        const threadId = asThreadId("thread-agy-turn-test");
        yield* adapter.startSession({
          threadId,
          cwd: dir,
          runtimeMode: "full-access",
        });

        const turnResult = yield* adapter.sendTurn({
          threadId,
          input: "Say hello",
        });

        expect(turnResult.turnId).toBeDefined();

        const collectedEvents = yield* Fiber.join(eventsFiber);
        const eventTypes = collectedEvents.map((e) => e.type);

        expect(eventTypes).toContain("turn.started");
        expect(eventTypes).toContain("content.delta");
        expect(eventTypes).toContain("item.started");
        expect(eventTypes).toContain("turn.completed");

        const textDelta = collectedEvents.find((e) => e.type === "content.delta");
        expect(textDelta).toBeDefined();
        if (textDelta && textDelta.type === "content.delta") {
          expect(textDelta.payload.delta).toBe("Hello from Antigravity!");
        }

        // Verify thread snapshot is populated after turn completion
        const threadSnapshot = yield* adapter.readThread(threadId);
        expect(threadSnapshot.turns.length).toBe(1);
        expect(threadSnapshot.turns[0]?.id).toBe(turnResult.turnId);

        const rollbackSnapshot = yield* adapter.rollbackThread(threadId, 1);
        expect(rollbackSnapshot.turns.length).toBe(0);

        yield* adapter.stopSession(threadId);
      }),
    ),
  );

  it.effect("handles tool step error state and emits failed item completion", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-agy-tool-err-" });
        const stubScript = path.join(dir, "agy-stub-tool-err.sh");

        const stubEvents = [
          '{"event":"init","conversation_id":"conv-err-1"}',
          '{"event":"step_update","step_update":{"conversation_id":"conv-err-1","step_index":0,"state":"ACTIVE","step_type":"tool","tool_name":"run_command"}}',
          '{"event":"step_update","step_update":{"conversation_id":"conv-err-1","step_index":0,"state":"ERROR","step_type":"tool","tool_name":"run_command","tool_info":{"output":"Command failed"}}}',
          '{"event":"result","result":{"conversation_id":"conv-err-1","status":"SUCCESS","response":"Recovered from tool failure"}}',
        ];

        yield* fs.writeFileString(
          stubScript,
          ["#!/bin/sh", ...stubEvents.map((e) => `printf '%s\\n' '${e}'`), "exit 0", ""].join("\n"),
        );
        yield* fs.chmod(stubScript, 0o755);

        const adapter = yield* makeAntigravityAdapter(
          decodeAntigravitySettings({ binaryPath: stubScript }),
        );

        const eventsFiber = yield* Stream.runCollect(
          adapter.streamEvents.pipe(Stream.takeUntil((e) => e.type === "turn.completed")),
        ).pipe(Effect.forkChild);

        const threadId = asThreadId("thread-agy-tool-err-test");
        yield* adapter.startSession({
          threadId,
          cwd: dir,
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId,
          input: "Run failing command",
        });

        const collectedEvents = yield* Fiber.join(eventsFiber);
        const itemCompleted = collectedEvents.find(
          (e) =>
            e.type === "item.completed" &&
            e.payload &&
            "status" in e.payload &&
            (e.payload as { status: string }).status === "failed",
        );
        expect(itemCompleted).toBeDefined();

        yield* adapter.stopSession(threadId);
      }),
    ),
  );

  it.effect("rejects a second sendTurn when a turn is already in progress", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-agy-concurrent-" });
        const stubScript = path.join(dir, "agy-stub-slow.sh");

        // Stub that stays active until interrupted
        yield* fs.writeFileString(
          stubScript,
          [
            "#!/bin/sh",
            'printf \'%s\\n\' \'{"event":"init","conversation_id":"conv-slow-1"}\'',
            "sleep 10",
            "exit 0",
            "",
          ].join("\n"),
        );
        yield* fs.chmod(stubScript, 0o755);

        const adapter = yield* makeAntigravityAdapter(
          decodeAntigravitySettings({ binaryPath: stubScript }),
        );

        const threadId = asThreadId("thread-agy-concurrent-test");
        yield* adapter.startSession({
          threadId,
          cwd: dir,
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId,
          input: "Slow turn 1",
        });

        const secondTurnResult = yield* adapter
          .sendTurn({
            threadId,
            input: "Overlapping turn 2",
          })
          .pipe(Effect.flip);

        expect(secondTurnResult._tag).toBe("ProviderAdapterValidationError");
        expect(secondTurnResult.message).toContain("already in progress");

        yield* adapter.interruptTurn(threadId);
        yield* adapter.stopSession(threadId);
      }),
    ),
  );
});
