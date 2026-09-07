import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProviderReauthenticateError,
  ServerProviderReauthenticateAttemptId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
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
  effect: (flow: ClaudeAuthFlow.ClaudeAuthFlow["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const flow = yield* ClaudeAuthFlow.ClaudeAuthFlow;
    return yield* effect(flow);
  }).pipe(Effect.provide(flowLayer(spawner)), Effect.provideService(HostProcessPlatform, "linux"));

const runWithNativeFlow = <A, E>(
  effect: (flow: ClaudeAuthFlow.ClaudeAuthFlow["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const flow = yield* ClaudeAuthFlow.ClaudeAuthFlow;
    return yield* effect(flow);
  }).pipe(
    Effect.provide(ClaudeAuthFlow.layer.pipe(Layer.provide(NodeServices.layer))),
    Effect.provideService(HostProcessPlatform, "linux"),
  );

const beginInput = (
  onSuccess: () => Effect.Effect<
    { readonly providers: ReadonlyArray<never> },
    ServerProviderReauthenticateError
  >,
): ClaudeAuthFlow.ClaudeAuthFlowBeginInput => ({
  provider: CLAUDE_DRIVER,
  instanceId,
  threadId,
  command: "claude",
  cwd: "/workspace",
  args: ["auth", "login"],
  onSuccess: () =>
    onSuccess().pipe(
      Effect.map((result) => ({
        ...result,
        continuation: "resumed" as const,
        continuationError: null,
      })),
    ),
});

describe("ClaudeAuthFlow", () => {
  it.effect("keeps native login stdin open for multiple code submissions", () =>
    runWithNativeFlow((flow) =>
      Effect.gen(function* () {
        const loginScript = String.raw`
process.stdout.write("Open https://claude.ai/oauth/authorize?state=multi-code\n");
process.stdin.setEncoding("utf8");
let received = "";
process.stdin.on("data", (chunk) => {
  received += chunk;
  if (received.endsWith("second-code\n")) process.exit(0);
});
process.stdin.on("end", () => process.exit(1));
`;
        const started = yield* flow.begin({
          ...beginInput(() => Effect.succeed({ providers: [] as const })),
          command: process.execPath,
          cwd: process.cwd(),
          args: ["-e", loginScript],
        });
        const first = yield* flow.submitCode({
          attemptId: started.attemptId,
          code: "first-code",
        });
        const second = yield* flow.submitCode({
          attemptId: started.attemptId,
          code: "second-code",
        });
        const completed = yield* flow.awaitCompletion(started.attemptId);
        assert.equal(first.status, "awaiting_code");
        assert.isTrue(second.status === "awaiting_code" || second.status === "succeeded");
        assert.equal(completed.status, "succeeded");
      }),
    ).pipe(Effect.scoped),
  );

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

  it.effect("rejects provider instance ids as auth attempt ids", () =>
    Effect.gen(function* () {
      const process = yield* makeFakeProcess({
        output: ["Open https://claude.ai/oauth/authorize?state=attempt-alias\n"],
      });
      const spawner = ChildProcessSpawner.make(() => Effect.succeed(process.handle));

      const result = yield* runWithFlow(spawner, (flow) =>
        Effect.gen(function* () {
          const started = yield* flow.begin(
            beginInput(() => Effect.succeed({ providers: [] as const })),
          );
          const alias = ServerProviderReauthenticateAttemptId.make(String(instanceId));
          const submitError = yield* flow
            .submitCode({ attemptId: alias, code: "alias-code" })
            .pipe(Effect.flip);
          const statusError = yield* flow.status(alias).pipe(Effect.flip);
          const cancelError = yield* flow.cancel(alias).pipe(Effect.flip);
          const stillActive = yield* flow.status(started.attemptId);
          const submitted = yield* flow.submitCode({
            attemptId: started.attemptId,
            code: "live-code",
          });
          const stdin = yield* Ref.get(process.stdin);
          const cancelled = yield* flow.cancel(started.attemptId);
          return {
            submitError,
            statusError,
            cancelError,
            stillActive,
            submitted,
            stdin,
            cancelled,
          };
        }),
      );

      for (const error of [result.submitError, result.statusError, result.cancelError]) {
        assert.equal(error.reason, "Authentication attempt was not found or has expired.");
      }
      assert.equal(result.stillActive.status, "awaiting_code");
      assert.equal(result.submitted.status, "awaiting_code");
      assert.equal(result.stdin, "live-code\n");
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

  it.effect("reports a completion callback failure as a failed continuation", () =>
    Effect.gen(function* () {
      const process = yield* makeFakeProcess({
        output: ["Open https://claude.ai/oauth/authorize?state=refresh-failure\n"],
      });
      const completionStarted = yield* Deferred.make<void>();
      const spawner = ChildProcessSpawner.make(() => Effect.succeed(process.handle));
      const completionError = new ServerProviderReauthenticateError({
        provider: CLAUDE_DRIVER,
        reason: "provider refresh failed",
      });

      const result = yield* runWithFlow(spawner, (flow) =>
        Effect.gen(function* () {
          const started = yield* flow.begin(
            beginInput(() =>
              Deferred.succeed(completionStarted, undefined).pipe(
                Effect.andThen(Effect.fail(completionError)),
              ),
            ),
          );
          yield* Deferred.succeed(process.exit, ChildProcessSpawner.ExitCode(0));
          yield* Deferred.await(completionStarted);
          return yield* flow.awaitCompletion(started.attemptId);
        }),
      );

      assert.equal(result.status, "succeeded");
      assert.equal(result.continuation, "failed");
      assert.equal(
        result.continuationError,
        "Claude is signed in, but the task could not resume. Send your message again.",
      );
      assert.isNull(result.error);
      assert.isUndefined(result.providers);
    }),
  );

  it.effect("reports a timed out completion callback as a failed continuation", () =>
    Effect.gen(function* () {
      const process = yield* makeFakeProcess({
        output: ["Open https://claude.ai/oauth/authorize?state=refresh-timeout\n"],
      });
      const completionStarted = yield* Deferred.make<void>();
      const spawner = ChildProcessSpawner.make(() => Effect.succeed(process.handle));

      const result = yield* runWithFlow(spawner, (flow) =>
        Effect.gen(function* () {
          const started = yield* flow.begin(
            beginInput(() =>
              Deferred.succeed(completionStarted, undefined).pipe(Effect.andThen(Effect.never)),
            ),
          );
          yield* Deferred.succeed(process.exit, ChildProcessSpawner.ExitCode(0));
          yield* Deferred.await(completionStarted);
          yield* TestClock.adjust(Duration.seconds(30));
          return yield* flow.awaitCompletion(started.attemptId);
        }),
      ).pipe(Effect.provide(TestClock.layer()));

      assert.equal(result.status, "succeeded");
      assert.equal(result.continuation, "failed");
      assert.equal(
        result.continuationError,
        "Claude is signed in, but the task could not resume. Send your message again.",
      );
      assert.isNull(result.error);
    }),
  );

  it.effect("does not invoke completion after cancellation wins before process success", () =>
    Effect.gen(function* () {
      const process = yield* makeFakeProcess({
        output: ["Open https://claude.ai/oauth/authorize?state=cancel-before-success\n"],
      });
      const completionStarted = yield* Deferred.make<void>();
      const spawner = ChildProcessSpawner.make(() => Effect.succeed(process.handle));

      const result = yield* runWithFlow(spawner, (flow) =>
        Effect.gen(function* () {
          const started = yield* flow.begin(
            beginInput(() =>
              Deferred.succeed(completionStarted, undefined).pipe(
                Effect.as({ providers: [] as const }),
              ),
            ),
          );
          const cancelled = yield* flow.cancel(started.attemptId);
          yield* Effect.yieldNow;
          return {
            cancelled,
            completionStarted: yield* Deferred.isDone(completionStarted),
          };
        }),
      );

      assert.equal(result.cancelled.status, "cancelled");
      assert.isFalse(result.completionStarted);
      assert.isTrue(yield* Ref.get(process.killed));
    }),
  );

  it.effect("waits for completion before returning from cancellation", () =>
    Effect.gen(function* () {
      const process = yield* makeFakeProcess({
        output: ["Open https://claude.ai/oauth/authorize?state=cancel-completing\n"],
      });
      const completionStarted = yield* Deferred.make<void>();
      const releaseCompletion = yield* Deferred.make<void>();
      const spawner = ChildProcessSpawner.make(() => Effect.succeed(process.handle));

      const result = yield* runWithFlow(spawner, (flow) =>
        Effect.gen(function* () {
          const started = yield* flow.begin(
            beginInput(() =>
              Deferred.succeed(completionStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseCompletion)),
                Effect.andThen(Effect.succeed({ providers: [] as const })),
              ),
            ),
          );
          yield* Deferred.succeed(process.exit, ChildProcessSpawner.ExitCode(0));
          yield* Deferred.await(completionStarted);

          const cancellation = yield* flow.cancel(started.attemptId).pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          assert.isUndefined(cancellation.pollUnsafe());
          assert.isFalse(yield* Deferred.isDone(releaseCompletion));

          yield* Deferred.succeed(releaseCompletion, undefined);
          return yield* Fiber.join(cancellation);
        }),
      );

      assert.equal(result.status, "succeeded");
      assert.equal(result.continuation, "resumed");
      assert.deepEqual(result.providers, []);
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
