// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  OmpSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { makeOmpAdapter } from "./OmpAdapter.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const decodeOmpSettings = Schema.decodeSync(OmpSettings);

async function makeMockOmpWrapper(input?: {
  readonly argvLogPath?: string;
  readonly environment?: Readonly<Record<string, string>>;
}) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "omp-acp-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-omp.sh");
  const exports = Object.entries(input?.environment ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const argvLog = input?.argvLogPath
    ? `printf '%s\\t' "$@" >> ${JSON.stringify(input.argvLogPath)}\nprintf '\\n' >> ${JSON.stringify(input.argvLogPath)}`
    : "";
  const script = `#!/bin/sh
${exports}
${argvLog}
exec bun ${JSON.stringify(mockAgentPath)} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-omp-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

it.effect("OMP adapter starts a scoped ACP session with profile and runtime policy", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "omp-argv-")),
      );
      const argvLogPath = NodePath.join(tempDir, "argv.txt");
      yield* Effect.promise(() => NodeFSP.writeFile(argvLogPath, "", "utf8"));
      const binaryPath = yield* Effect.promise(() => makeMockOmpWrapper({ argvLogPath }));
      const adapter = yield* makeOmpAdapter(
        decodeOmpSettings({ binaryPath, profile: "work", enabled: true }),
      );
      const threadId = ThreadId.make("omp-session");

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        providerInstanceId: ProviderInstanceId.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("omp"),
          model: "default",
        },
      });

      assert.equal(session.provider, "omp");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });
      assert.deepStrictEqual(
        (yield* Effect.promise(() => NodeFSP.readFile(argvLogPath, "utf8")))
          .trim()
          .split("\t")
          .filter(Boolean),
        ["acp", "--profile", "work", "--approval-mode", "yolo"],
      );
      const rollbackError = yield* adapter.rollbackThread(threadId, 1).pipe(Effect.flip);
      assert.equal(rollbackError._tag, "ProviderAdapterRequestError");

      yield* adapter.stopSession(threadId);
    }).pipe(Effect.provide(testLayer)),
  ),
);

it.effect("OMP adapter bridges standard ACP form elicitation to provider user input", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() =>
        makeMockOmpWrapper({ environment: { T3_ACP_EMIT_ELICITATION: "1" } }),
      );
      const adapter = yield* makeOmpAdapter(decodeOmpSettings({ binaryPath, enabled: true }));
      const threadId = ThreadId.make("omp-elicitation");
      const requested = yield* Deferred.make<{
        readonly requestId: string;
        readonly questions: ReadonlyArray<{ readonly id: string }>;
      }>();
      const resolved = yield* Deferred.make<Record<string, unknown>>();

      yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (event.threadId !== threadId) return Effect.void;
        if (event.type === "user-input.requested") {
          return Deferred.succeed(requested, {
            requestId: String(event.requestId),
            questions: event.payload.questions,
          }).pipe(Effect.ignore);
        }
        if (event.type === "user-input.resolved") {
          return Deferred.succeed(resolved, event.payload.answers).pipe(Effect.ignore);
        }
        return Effect.void;
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        providerInstanceId: ProviderInstanceId.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("omp"),
          model: "default",
        },
      });
      const turnFiber = yield* adapter
        .sendTurn({ threadId, input: "ask me", attachments: [] })
        .pipe(Effect.forkChild);

      const request = yield* Deferred.await(requested);
      assert.deepStrictEqual(
        request.questions.map((question) => question.id),
        ["strategy"],
      );
      yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make(request.requestId), {
        strategy: "safe",
      });
      yield* Fiber.join(turnFiber);
      assert.deepStrictEqual(yield* Deferred.await(resolved), { strategy: "safe" });

      yield* adapter.stopSession(threadId);
    }).pipe(Effect.provide(testLayer)),
  ),
);

it.effect(
  "OMP adapter cancels unsupported optionless elicitation without waiting for web input",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* Effect.promise(() =>
          makeMockOmpWrapper({
            environment: { T3_ACP_EMIT_UNSUPPORTED_ELICITATION: "1" },
          }),
        );
        const adapter = yield* makeOmpAdapter(decodeOmpSettings({ binaryPath, enabled: true }));
        const threadId = ThreadId.make("omp-unsupported-elicitation");
        let sawUserInputRequest = false;

        yield* Stream.runForEach(adapter.streamEvents, (event) => {
          if (event.threadId === threadId && event.type === "user-input.requested") {
            sawUserInputRequest = true;
          }
          return Effect.void;
        }).pipe(Effect.forkChild);

        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("omp"),
          providerInstanceId: ProviderInstanceId.make("omp"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: {
            instanceId: ProviderInstanceId.make("omp"),
            model: "default",
          },
        });

        // Completion proves the ACP request was answered immediately instead of
        // leaving the turn blocked on a prompt the web client cannot render.
        yield* adapter.sendTurn({ threadId, input: "ask for free text", attachments: [] });
        assert.isFalse(sawUserInputRequest);

        yield* adapter.stopSession(threadId);
      }).pipe(Effect.provide(testLayer)),
    ),
);
