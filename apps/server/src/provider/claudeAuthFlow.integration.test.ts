import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as ClaudeAuthFlow from "./claudeAuthFlow.ts";

it.effect("cancels a login process that ignores SIGTERM", () =>
  Effect.gen(function* () {
    // Windows terminates directly instead of delivering catchable SIGTERM.
    if ((yield* HostProcessPlatform) === "win32") return;
    const nativeSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const terminationIgnored = yield* Deferred.make<void>();
    const spawner = ChildProcessSpawner.make((command) =>
      nativeSpawner.spawn(command).pipe(
        Effect.tap((handle) =>
          Effect.addFinalizer(() => handle.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore)),
        ),
        Effect.map((handle) =>
          ChildProcessSpawner.makeHandle({
            ...handle,
            all: handle.all.pipe(
              Stream.decodeText,
              Stream.splitLines,
              Stream.tap((line) =>
                line === "termination ignored"
                  ? Deferred.succeed(terminationIgnored, undefined)
                  : Effect.void,
              ),
              Stream.map((line) => `${line}\n`),
              Stream.encodeText,
            ),
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const flow = yield* ClaudeAuthFlow.ClaudeAuthFlow;
      const started = yield* flow.begin({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: ProviderInstanceId.make("stubborn-login"),
        threadId: ThreadId.make("stubborn-login-thread"),
        command: process.execPath,
        args: [
          "-e",
          `process.on("SIGTERM", () => console.log("termination ignored")); console.log("https://claude.ai/oauth/authorize?state=stubborn"); setInterval(() => {}, 1000);`,
        ],
        cwd: process.cwd(),
        onSuccess: () => Effect.die("cancelled login must not continue"),
      });
      assert.equal(started.status, "awaiting_code");
      const cancellation = yield* flow.cancel(started.attemptId).pipe(Effect.forkChild);
      yield* Deferred.await(terminationIgnored);
      yield* TestClock.adjust(Duration.seconds(2));
      assert.equal((yield* Fiber.join(cancellation)).status, "cancelled");
    }).pipe(
      Effect.provide(
        ClaudeAuthFlow.layer.pipe(
          Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
