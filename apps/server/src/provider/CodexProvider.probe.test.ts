import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CodexSettings } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { checkCodexProviderStatus } from "./CodexProvider.ts";

const decodeCodexSettings = Schema.decodeSync(CodexSettings);
const decodeRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
      method: Schema.String,
    }),
  ),
);

const startProbe = Effect.fn("startProbe")(function* (
  options: {
    hang?: string;
    delayAccount?: boolean;
    slowCleanup?: boolean;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const homePath = yield* fs.makeTempDirectoryScoped();
  yield* fs.writeFileString(
    `${homePath}/models_cache.json`,
    JSON.stringify({
      fetched_at: DateTime.formatIso(yield* DateTime.now),
    }),
  );
  const output = yield* Queue.unbounded<Uint8Array>();
  const requests = yield* Queue.unbounded<string>();
  const accountRequest = yield* Deferred.make<string | number>();
  const cleanupStarted = yield* Deferred.make<void>();
  const stopped = yield* Deferred.make<void>();
  let modelRequests = 0;
  const reply = (id: string | number, result: unknown) =>
    Queue.offer(output, new TextEncoder().encode(`${JSON.stringify({ id, result })}\n`));
  const account = {
    account: { type: "chatgpt", email: "test@example.com", planType: "pro" },
    requiresOpenaiAuth: false,
  };
  const spawner = ChildProcessSpawner.make(() =>
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* Deferred.succeed(cleanupStarted, undefined);
          if (options.slowCleanup) yield* Effect.sleep("2 seconds");
          yield* Deferred.succeed(stopped, undefined);
        }),
      );
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Deferred.await(stopped).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
        isRunning: Deferred.isDone(stopped).pipe(Effect.map((done) => !done)),
        kill: () => Deferred.succeed(stopped, undefined).pipe(Effect.asVoid),
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((bytes: Uint8Array) =>
          Effect.forEach(
            new TextDecoder().decode(bytes).split("\n").filter(Boolean),
            (line) =>
              Effect.gen(function* () {
                const { id, method } = decodeRequest(line);
                if (id === undefined) return;
                if (method === "model/list") modelRequests++;
                yield* Queue.offer(
                  requests,
                  method === "model/list" ? `model/list/${modelRequests}` : method,
                );
                if (
                  method === options.hang ||
                  (options.hang === "second-list" && modelRequests === 2 && method === "model/list")
                )
                  return;
                if (method === "account/read") {
                  if (options.delayAccount) yield* Deferred.succeed(accountRequest, id);
                  else yield* reply(id, account);
                } else if (method === "initialize") {
                  yield* reply(id, {
                    userAgent: "codex/0.163.0",
                    codexHome: homePath,
                    platformFamily: "unix",
                    platformOs: "linux",
                  });
                } else if (method === "model/list") {
                  yield* reply(id, {
                    data: [
                      {
                        id: "gpt-test",
                        model: "gpt-test",
                        displayName: "Test",
                        description: "",
                        hidden: false,
                        isDefault: true,
                        defaultReasoningEffort: "high",
                        supportedReasoningEfforts: [],
                      },
                    ],
                    nextCursor: null,
                  });
                } else if (method === "skills/list") {
                  yield* reply(id, { data: [] });
                }
              }),
            { discard: true },
          ),
        ),
        stdout: Stream.fromQueue(output),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  const fiber = yield* checkCodexProviderStatus(
    decodeCodexSettings({
      homePath,
      customModels: [{ slug: "custom-model" }],
    }),
  ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner), Effect.forkChild);
  const waitFor = Effect.fn("waitFor")(function* (method: string) {
    let received: string;
    do {
      received = yield* Queue.take(requests);
    } while (received !== method);
  });
  return {
    fiber,
    waitFor,
    cleanupStarted,
    stopped,
    releaseAccount: Deferred.await(accountRequest).pipe(Effect.flatMap((id) => reply(id, account))),
  };
});

it.effect("keeps the first complete catalog when the refreshed model list hangs", () =>
  Effect.gen(function* () {
    const probe = yield* startProbe({ hang: "second-list" });
    yield* probe.waitFor("model/list/2");
    yield* TestClock.adjust("20 seconds");
    const provider = yield* Fiber.join(probe.fiber);
    assert.strictEqual(provider.status, "ready");
    assert.strictEqual(provider.auth.status, "authenticated");
    assert.deepStrictEqual(
      provider.models.map((model) => model.slug),
      ["gpt-test", "custom-model"],
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("warns with custom models when the first catalog request hangs", () =>
  Effect.gen(function* () {
    const probe = yield* startProbe({ hang: "model/list" });
    yield* probe.waitFor("model/list/1");
    yield* TestClock.adjust("20 seconds");
    const provider = yield* Fiber.join(probe.fiber);
    assert.strictEqual(provider.status, "warning");
    assert.strictEqual(provider.auth.status, "authenticated");
    assert.strictEqual(provider.message, "Codex did not return its model catalog in time.");
    assert.deepStrictEqual(
      provider.models.map((model) => model.slug),
      ["custom-model"],
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("keeps authentication when skills discovery hangs", () =>
  Effect.gen(function* () {
    const probe = yield* startProbe({ hang: "skills/list" });
    yield* probe.waitFor("model/list/2");
    yield* TestClock.adjust("20 seconds");
    const provider = yield* Fiber.join(probe.fiber);
    assert.strictEqual(provider.status, "ready");
    assert.strictEqual(provider.auth.status, "authenticated");
    assert.deepStrictEqual(provider.skills, []);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("preserves a late account result through slow process cleanup", () =>
  Effect.gen(function* () {
    const probe = yield* startProbe({ hang: "model/list", delayAccount: true, slowCleanup: true });
    yield* probe.waitFor("account/read");
    yield* TestClock.adjust(18_500);
    yield* probe.releaseAccount;
    yield* probe.waitFor("model/list/1");
    yield* TestClock.adjust(1_500);
    yield* Deferred.await(probe.cleanupStarted);
    assert.strictEqual(yield* Deferred.isDone(probe.stopped), false);
    yield* TestClock.adjust("2 seconds");
    const provider = yield* Fiber.join(probe.fiber);
    assert.strictEqual(provider.status, "warning");
    assert.strictEqual(provider.auth.status, "authenticated");
    assert.strictEqual(yield* Deferred.isDone(probe.stopped), true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("keeps the timeout error when the account request never answers", () =>
  Effect.gen(function* () {
    const probe = yield* startProbe({ hang: "account/read" });
    yield* probe.waitFor("account/read");
    yield* TestClock.adjust("21 seconds");
    const provider = yield* Fiber.join(probe.fiber);
    assert.strictEqual(provider.status, "error");
    assert.strictEqual(provider.auth.status, "unknown");
    assert.strictEqual(
      provider.message,
      "Timed out while checking Codex app-server provider status.",
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
