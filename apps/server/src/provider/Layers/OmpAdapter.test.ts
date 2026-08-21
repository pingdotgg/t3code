// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { OmpSettings, ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import type { OmpAdapterShape } from "../Services/OmpAdapter.ts";
import {
  buildOmpElicitationContent,
  ompElicitationQuestions,
  selectOmpPermissionOptionId,
} from "../acp/OmpAcpSupport.ts";
import { makeOmpAdapter } from "./OmpAdapter.ts";

const decodeOmpSettings = Schema.decodeSync(OmpSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

class OmpAdapter extends Context.Service<OmpAdapter, OmpAdapterShape>()(
  "t3/provider/Layers/OmpAdapter.test/OmpAdapter",
) {}

async function makeMockAgentWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "omp-acp-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-omp.sh");
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
${envExports}
exec node ${JSON.stringify(mockAgentPath)} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

const ompAdapterTestLayer = it.layer(
  Layer.effect(
    OmpAdapter,
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const resolveSettings = serverSettings.getSettings.pipe(
        Effect.map((snapshot) => snapshot.providers.omp),
        Effect.orDie,
      );
      return yield* makeOmpAdapter(decodeOmpSettings({}), { resolveSettings });
    }),
  ).pipe(
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3code-omp-adapter-test-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

describe("OMP elicitation mapping", () => {
  it("maps OMP choice forms and custom answers", () => {
    const request = {
      mode: "form",
      sessionId: "session-1",
      message: "Choose a deployment target",
      requestedSchema: {
        type: "object",
        properties: {
          q0: {
            type: "string",
            title: "Where should this deploy?",
            oneOf: [
              { const: "Preview", title: "Preview" },
              { const: "Production", title: "Production" },
            ],
          },
          q0__other: { type: "string", title: "Other" },
          confirmed: { type: "boolean", title: "Continue?" },
        },
      },
    } as const;

    const questions = ompElicitationQuestions(request);
    assert.deepStrictEqual(
      questions.map((entry) => entry.question.id),
      ["q0", "confirmed"],
    );
    assert.deepStrictEqual(
      buildOmpElicitationContent(questions, { q0: "Staging", confirmed: "Yes" }),
      {
        q0__other: "Staging",
        confirmed: true,
      },
    );
  });
});

describe("OMP permission mapping", () => {
  it("returns the option ID that OMP supplied for each decision", () => {
    const request = {
      sessionId: "session-1",
      toolCall: {
        toolCallId: "tool-1",
        title: "Edit file",
      },
      options: [
        { optionId: "omp_allow_once", name: "Allow once", kind: "allow_once" },
        { optionId: "omp_allow_always", name: "Always allow", kind: "allow_always" },
        { optionId: "omp_reject_once", name: "Reject", kind: "reject_once" },
      ],
    } as const;

    assert.equal(selectOmpPermissionOptionId(request, "accept"), "omp_allow_once");
    assert.equal(selectOmpPermissionOptionId(request, "acceptForSession"), "omp_allow_always");
    assert.equal(selectOmpPermissionOptionId(request, "decline"), "omp_reject_once");
  });
});

ompAdapterTestLayer("OmpAdapterLive", (it) => {
  it.effect("starts an OMP ACP session and maps a prompt to runtime events", () =>
    Effect.gen(function* () {
      const adapter = yield* OmpAdapter;
      const serverSettings = yield* ServerSettingsService;
      const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper());
      yield* serverSettings.updateSettings({
        providers: { omp: { binaryPath: wrapperPath, enabled: true } },
      });
      const threadId = ThreadId.make("omp-mock-thread");
      const eventsFiber = yield* Stream.take(adapter.streamEvents, 9).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("omp"),
          model: "composer-2",
        },
      });
      assert.equal(session.provider, "omp");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "hello mock",
        attachments: [],
      });

      const events = Array.from(yield* Fiber.join(eventsFiber));
      const eventTypes = events.map((event) => event.type);
      for (const eventType of [
        "session.started",
        "session.state.changed",
        "thread.started",
        "turn.started",
        "turn.plan.updated",
        "item.started",
        "content.delta",
        "item.completed",
        "turn.completed",
      ] as const) {
        assert.include(eventTypes, eventType);
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("rejects an OMP session when the provider does not match", () =>
    Effect.gen(function* () {
      const adapter = yield* OmpAdapter;
      const result = yield* adapter
        .startSession({
          threadId: ThreadId.make("omp-provider-mismatch"),
          provider: ProviderDriverKind.make("codex"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
    }),
  );

  it.effect("loads an OMP ACP session from its resume cursor", () =>
    Effect.gen(function* () {
      const adapter = yield* OmpAdapter;
      const serverSettings = yield* ServerSettingsService;
      const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper());
      yield* serverSettings.updateSettings({
        providers: { omp: { binaryPath: wrapperPath, enabled: true } },
      });
      const threadId = ThreadId.make("omp-resume-thread");
      const started = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.stopSession(threadId);

      const resumed = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: started.resumeCursor,
      });

      assert.deepStrictEqual(resumed.resumeCursor, started.resumeCursor);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("queues concurrent prompts as distinct turns", () =>
    Effect.gen(function* () {
      const adapter = yield* OmpAdapter;
      const serverSettings = yield* ServerSettingsService;
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_PROMPT_DELAY_MS: "25" }),
      );
      yield* serverSettings.updateSettings({
        providers: { omp: { binaryPath: wrapperPath, enabled: true } },
      });
      const threadId = ThreadId.make("omp-concurrent-prompts");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const [first, second] = yield* Effect.all(
        [
          adapter.sendTurn({ threadId, input: "first", attachments: [] }),
          adapter.sendTurn({ threadId, input: "second", attachments: [] }),
        ],
        { concurrency: 2 },
      );

      assert.notEqual(first.turnId, second.turnId);
      const thread = yield* adapter.readThread(threadId);
      assert.equal(thread.turns.length, 2);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("auto-approves OMP edit gates in auto-accept-edits mode", () =>
    Effect.gen(function* () {
      const adapter = yield* OmpAdapter;
      const serverSettings = yield* ServerSettingsService;
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({
          T3_ACP_EMIT_TOOL_CALLS: "1",
          T3_ACP_EMIT_EDIT_PERMISSION: "1",
        }),
      );
      yield* serverSettings.updateSettings({
        providers: { omp: { binaryPath: wrapperPath, enabled: true } },
      });
      const threadId = ThreadId.make("omp-auto-accept-edit");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "auto-accept-edits",
      });

      const turn = yield* adapter.sendTurn({ threadId, input: "delete it", attachments: [] });

      assert.equal(turn.threadId, threadId);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("rejects rollback because OMP cannot restore provider history", () =>
    Effect.gen(function* () {
      const adapter = yield* OmpAdapter;
      const serverSettings = yield* ServerSettingsService;
      const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper());
      yield* serverSettings.updateSettings({
        providers: { omp: { binaryPath: wrapperPath, enabled: true } },
      });
      const threadId = ThreadId.make("omp-rollback-unsupported");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const result = yield* adapter.rollbackThread(threadId, 1).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.include(String(result.failure), "do not support provider-side rollback");
      }
      yield* adapter.stopSession(threadId);
    }),
  );
});
