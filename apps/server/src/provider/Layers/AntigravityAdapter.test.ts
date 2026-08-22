import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { AntigravitySettings, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import { makeAntigravityAdapter } from "./AntigravityAdapter.ts";

const decodeAntigravitySettings = Schema.decodeSync(AntigravitySettings);

const makeMockAgyScript = (lines: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectory({ prefix: "agy-mock-" });
    const scriptPath = path.join(dir, "fake-agy.sh");
    const outputScript = [
      "#!/bin/sh",
      ...lines.map((line) => `printf '%s\\n' '${line}'`),
      "exit 0",
      "",
    ].join("\n");
    yield* fs.writeFileString(scriptPath, outputScript);
    yield* fs.chmod(scriptPath, 0o755);
    return scriptPath;
  });

it.layer(NodeServices.layer)("makeAntigravityAdapter", (it) => {
  it.effect("starts and stops a session", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAntigravityAdapter(decodeAntigravitySettings({ enabled: true }));
      const threadId = ThreadId.make("thread-1");

      const session = yield* adapter.startSession({
        threadId,
        runtimeMode: "full-access",
      });

      expect(session.threadId).toBe(threadId);
      expect(session.provider).toBe("antigravity");
      expect(session.providerInstanceId).toBe("antigravity");
      expect(session.status).toBe("ready");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("binds custom instanceId to session", () =>
    Effect.gen(function* () {
      const customInstanceId = ProviderInstanceId.make("antigravity-secondary");
      const adapter = yield* makeAntigravityAdapter(decodeAntigravitySettings({ enabled: true }), {
        instanceId: customInstanceId,
      });
      const threadId = ThreadId.make("thread-2");

      const session = yield* adapter.startSession({
        threadId,
        runtimeMode: "full-access",
      });

      expect(session.providerInstanceId).toBe(customInstanceId);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("executes a turn and translates stream events", () =>
    Effect.gen(function* () {
      const mockScript = yield* makeMockAgyScript([
        '{"event":"init","conversation_id":"conv-123"}',
        '{"event":"step_update","step_update":{"step_index":0,"step_type":"agent_response","text_delta":"Hello from Antigravity!","state":"DONE","usage":{"total_tokens":100,"input_tokens":40,"output_tokens":60}}}',
        '{"event":"result","result":{"conversation_id":"conv-123"}}',
      ]);

      const adapter = yield* makeAntigravityAdapter(
        decodeAntigravitySettings({
          enabled: true,
          binaryPath: mockScript,
        }),
      );

      const threadId = ThreadId.make("thread-turn-test");
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 5).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* Effect.yieldNow;

      const result = yield* adapter.sendTurn({
        threadId,
        input: "Hi",
      });

      expect(result.threadId).toBe(threadId);
      expect(result.turnId).toBeDefined();

      const eventsChunk = yield* Fiber.join(runtimeEventsFiber);
      const types = Array.from(eventsChunk).map((e) => e.type);

      expect(types).toContain("turn.started");
      expect(types).toContain("session.state.changed");
      expect(types).toContain("content.delta");
      expect(types).toContain("thread.token-usage.updated");
      expect(types).toContain("turn.completed");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("handles turn interruption safely", () =>
    Effect.gen(function* () {
      const mockScript = yield* makeMockAgyScript([
        '{"event":"init","conversation_id":"conv-long"}',
      ]);

      const adapter = yield* makeAntigravityAdapter(
        decodeAntigravitySettings({
          enabled: true,
          binaryPath: mockScript,
        }),
      );

      const threadId = ThreadId.make("thread-interrupt-test");
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });

      const turnResult = yield* adapter.sendTurn({
        threadId,
        input: "Test interrupt",
      });

      yield* adapter.interruptTurn(threadId, turnResult.turnId);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("passes selected model and effort to agy CLI arguments", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectory({ prefix: "agy-mock-args-" });
      const argsLog = path.join(dir, "args.log");
      const scriptPath = path.join(dir, "fake-agy.sh");
      yield* fs.writeFileString(
        scriptPath,
        `#!/bin/sh\nprintf "%s\\n" "$*" > "${argsLog}"\nprintf '{"event":"init","conversation_id":"conv-args"}\\n{"event":"result","result":{"conversation_id":"conv-args"}}\\n'\nexit 0\n`,
      );
      yield* fs.chmod(scriptPath, 0o755);

      const adapter = yield* makeAntigravityAdapter(
        decodeAntigravitySettings({
          enabled: true,
          binaryPath: scriptPath,
        }),
      );

      const threadId = ThreadId.make("thread-args-test");
      yield* adapter.startSession({
        threadId,
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("antigravity"),
          model: "gemini-3.7-flash",
          options: [{ id: "effort", value: "high" }],
        },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "Hello with high effort",
        modelSelection: {
          instanceId: ProviderInstanceId.make("antigravity"),
          model: "gemini-3.7-flash",
          options: [{ id: "effort", value: "high" }],
        },
      });

      const loggedArgs = yield* fs.readFileString(argsLog);
      expect(loggedArgs).toContain("--model gemini-3.7-flash");
      expect(loggedArgs).toContain("--effort high");

      yield* adapter.stopSession(threadId);
    }),
  );
});
