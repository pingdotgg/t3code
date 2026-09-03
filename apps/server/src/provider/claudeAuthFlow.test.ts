import { ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as ClaudeAuthFlow from "./claudeAuthFlow.ts";

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const instanceId = ProviderInstanceId.make("claude-test");
const threadId = ThreadId.make("thread-claude-auth");
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface FakeProcess {
  readonly handle: ChildProcessSpawner.ChildProcessHandle;
  readonly exit: Deferred.Deferred<ChildProcessSpawner.ExitCode>;
  readonly stdin: Ref.Ref<string>;
  readonly killed: Ref.Ref<boolean>;
}

const makeFakeProcess = Effect.fn("claudeAuthFlow.test.makeFakeProcess")(function* (input: {
  readonly output: ReadonlyArray<string>;
}) {
  const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
  const stdin = yield* Ref.make("");
  const killed = yield* Ref.make(false);
  const handle = ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Deferred.await(exit),
    isRunning: Effect.succeed(true),
    kill: () =>
      Ref.set(killed, true).pipe(
        Effect.andThen(Deferred.succeed(exit, ChildProcessSpawner.ExitCode(143))),
        Effect.asVoid,
      ),
    unref: Effect.succeed(Effect.void),
    stdin: Sink.forEach((chunk: Uint8Array) =>
      Ref.update(stdin, (previous) => previous + decoder.decode(chunk, { stream: true })),
    ),
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.fromIterable(input.output.map((chunk) => encoder.encode(chunk))),
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
  return { handle, exit, stdin, killed } satisfies FakeProcess;
});

const flowLayer = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) =>
  ClaudeAuthFlow.layer.pipe(
    Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
  );

const runWithFlow = <A, E>(
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  effect: (flow: ClaudeAuthFlow.ClaudeAuthFlowShape) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const flow = yield* ClaudeAuthFlow.ClaudeAuthFlow;
    return yield* effect(flow);
  }).pipe(Effect.provide(flowLayer(spawner)), Effect.provideService(HostProcessPlatform, "linux"));

const beginInput = (onSuccess: () => Effect.Effect<{ readonly providers: [] }>) => ({
  provider: CLAUDE_DRIVER,
  instanceId,
  threadId,
  command: "claude",
  args: ["auth", "login"],
  onSuccess,
});

describe("ClaudeAuthFlow", () => {
  it.effect("surfaces an ANSI-wrapped authorization URL assembled across output chunks", () =>
    Effect.gen(function* () {
      const process = yield* makeFakeProcess({
        output: [
          "\u001b[2mOpen https://claude.ai/oauth/author",
          "ize?state=browser-state\u001b[0m\n",
        ],
      });
      const spawner = ChildProcessSpawner.make(() => Effect.succeed(process.handle));

      const result = yield* runWithFlow(spawner, (flow) =>
        Effect.gen(function* () {
          const started = yield* flow.begin(
            beginInput(() => Effect.succeed({ providers: [] as const })),
          );
          const cancelled = yield* flow.cancel(started.attemptId);
          return { started, cancelled };
        }),
      );

      assert.equal(result.started.status, "awaiting_code");
      assert.equal(
        result.started.authorizationUrl,
        "https://claude.ai/oauth/authorize?state=browser-state",
      );
      assert.equal(result.started.threadId, threadId);
      assert.equal(result.cancelled.status, "cancelled");
    }),
  );

  it.effect("completes browser-only login and refreshes the provider snapshot", () =>
    Effect.gen(function* () {
      const process = yield* makeFakeProcess({
        output: ["Open https://claude.ai/oauth/authorize?state=browser-state\n"],
      });
      const refreshed = yield* Ref.make(false);
      const spawner = ChildProcessSpawner.make(() => Effect.succeed(process.handle));

      const result = yield* runWithFlow(spawner, (flow) =>
        Effect.gen(function* () {
          const started = yield* flow.begin(
            beginInput(() => Ref.set(refreshed, true).pipe(Effect.as({ providers: [] as const }))),
          );
          yield* Deferred.succeed(process.exit, ChildProcessSpawner.ExitCode(0));
          const completed = yield* flow.awaitCompletion(started.attemptId);
          return { started, completed };
        }),
      );

      assert.equal(result.started.status, "awaiting_code");
      assert.equal(result.completed.status, "succeeded");
      assert.deepEqual(result.completed.providers, []);
      assert.isTrue(yield* Ref.get(refreshed));
    }),
  );

  it.effect("writes a pasted code to the login process without exposing it in status", () =>
    Effect.gen(function* () {
      const process = yield* makeFakeProcess({
        output: ["Open https://claude.ai/oauth/authorize?state=code-state\n"],
      });
      const spawner = ChildProcessSpawner.make(() => Effect.succeed(process.handle));

      const result = yield* runWithFlow(spawner, (flow) =>
        Effect.gen(function* () {
          const started = yield* flow.begin(
            beginInput(() => Effect.succeed({ providers: [] as const })),
          );
          const submitted = yield* flow.submitCode({
            attemptId: started.attemptId,
            code: "  pasted-code-that-must-stay-private  ",
          });
          const stdin = yield* Ref.get(process.stdin);
          const cancelled = yield* flow.cancel(started.attemptId);
          return { started, submitted, stdin, cancelled };
        }),
      );

      assert.equal(result.submitted.status, "awaiting_code");
      assert.equal(result.stdin, "pasted-code-that-must-stay-private\n");
      assert.notInclude(result.submitted.error ?? "", "pasted-code-that-must-stay-private");
      assert.equal(result.cancelled.status, "cancelled");
    }),
  );

  it.effect("allows only one active login per provider instance and supports cancellation", () =>
    Effect.gen(function* () {
      const process = yield* makeFakeProcess({
        output: ["Open https://claude.ai/oauth/authorize?state=single-flight\n"],
      });
      let spawnCount = 0;
      const spawner = ChildProcessSpawner.make(() =>
        Effect.sync(() => {
          spawnCount += 1;
          return process.handle;
        }),
      );

      const result = yield* runWithFlow(spawner, (flow) =>
        Effect.gen(function* () {
          const first = yield* flow.begin(
            beginInput(() => Effect.succeed({ providers: [] as const })),
          );
          const secondError = yield* flow
            .begin(beginInput(() => Effect.succeed({ providers: [] as const })))
            .pipe(Effect.flip);
          const cancelled = yield* flow.cancel(first.attemptId);
          return { first, secondError, cancelled };
        }),
      );

      assert.equal(spawnCount, 1);
      assert.include(result.secondError.reason, "already in progress");
      assert.equal(result.cancelled.status, "cancelled");
      assert.isTrue(yield* Ref.get(process.killed));
    }),
  );

  it.effect("returns a stable failure without raw OAuth output", () =>
    Effect.gen(function* () {
      const process = yield* makeFakeProcess({
        output: [
          "Open https://claude.ai/oauth/authorize?state=error-state\n",
          "OAuth access_token=super-secret-value\n",
        ],
      });
      const spawner = ChildProcessSpawner.make(() => Effect.succeed(process.handle));

      const result = yield* runWithFlow(spawner, (flow) =>
        Effect.gen(function* () {
          const started = yield* flow.begin(
            beginInput(() => Effect.succeed({ providers: [] as const })),
          );
          yield* Deferred.succeed(process.exit, ChildProcessSpawner.ExitCode(1));
          return yield* flow.awaitCompletion(started.attemptId);
        }),
      );

      assert.equal(result.status, "failed");
      assert.equal(result.error, "claude auth login exited with code 1.");
      assert.notInclude(result.error ?? "", "super-secret-value");
    }),
  );

  it("accepts only HTTPS authorization URLs owned by Anthropic", () => {
    assert.equal(
      ClaudeAuthFlow.extractClaudeAuthorizationUrl("https://claude.com/oauth/authorize?state=ok"),
      "https://claude.com/oauth/authorize?state=ok",
    );
    assert.equal(
      ClaudeAuthFlow.extractClaudeAuthorizationUrl("https://claude.ai/oauth/authorize?state=ok"),
      "https://claude.ai/oauth/authorize?state=ok",
    );
    assert.isNull(
      ClaudeAuthFlow.extractClaudeAuthorizationUrl("https://example.com/oauth/authorize?secret=x"),
    );
    assert.isNull(
      ClaudeAuthFlow.extractClaudeAuthorizationUrl("http://claude.ai/oauth/authorize?secret=x"),
    );
  });
});
