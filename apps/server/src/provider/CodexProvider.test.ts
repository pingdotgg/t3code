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

import {
  applyPreferredCodexDefaultModel,
  checkCodexProviderStatus,
  mapCodexModelCapabilities,
} from "./CodexProvider.ts";

it("maps current Codex model capability fields", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    defaultReasoningEffort: "super-high",
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    defaultServiceTier: "flex",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "Lower latency responses.",
      },
      {
        id: "flex",
        name: "Flex",
        description: "Lower-cost asynchronous routing.",
      },
    ],
    supportedReasoningEfforts: [
      {
        description: "Maximum reasoning",
        reasoningEffort: "super-high",
      },
    ],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [{ id: "super-high", label: "super-high", isDefault: true }],
      currentValue: "super-high",
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard" },
        {
          id: "priority",
          label: "Fast",
          description: "Lower latency responses.",
        },
        {
          id: "flex",
          label: "Flex",
          description: "Lower-cost asynchronous routing.",
          isDefault: true,
        },
      ],
      currentValue: "flex",
    },
  ]);
});

it("uses standard routing when the catalog has no default service tier", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: ["fast"],
    defaultReasoningEffort: "medium",
    defaultServiceTier: null,
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "1.5x speed, increased usage",
      },
      {
        id: "ultrafast",
        name: "Ultrafast",
        description: "The fastest available responses for latency-sensitive work.",
      },
    ],
    supportedReasoningEfforts: [],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        {
          id: "priority",
          label: "Fast",
          description: "1.5x speed, increased usage",
        },
        {
          id: "ultrafast",
          label: "Ultrafast",
          description: "Even faster, more expensive",
        },
      ],
      currentValue: "default",
    },
  ]);
});

it("marks the most preferred available model as default", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(
    models.map((model) => ({ slug: model.slug, isDefault: model.isDefault })),
    [
      { slug: "gpt-5.6-terra", isDefault: true },
      { slug: "gpt-5.4", isDefault: undefined },
    ],
  );
});

it("prefers sol over terra when both are available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.6-sol", name: "GPT-5.6-Sol", isCustom: false, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.6-sol");
});

it("ranks qualified Codex models while preserving their wire ids", () => {
  const models = applyPreferredCodexDefaultModel([
    {
      slug: "openai.gpt-5.6-luna",
      name: "Luna",
      isCustom: false,
      isDefault: true,
      capabilities: null,
    },
    { slug: "openai.gpt-5.6-sol", name: "Sol", isCustom: false, capabilities: null },
  ]);
  assert.deepStrictEqual(
    models.filter((model) => model.isDefault).map((model) => model.slug),
    ["openai.gpt-5.6-sol"],
  );
});

it("keeps Codex's own default when no preferred model is available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.5", name: "GPT-5.5", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});

it("ignores custom models that shadow a preferred slug", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-sol", name: "gpt-5.6-sol", isCustom: true, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});

const decodeCodexSettings = Schema.decodeSync(CodexSettings);
const decodeRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
      method: Schema.String,
    }),
  ),
);
const account = {
  account: { type: "chatgpt", email: "test@example.com", planType: "pro" },
  requiresOpenaiAuth: false,
} as const;

const startProbe = Effect.fn("startProbe")(function* (hang: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem;
  const homePath = yield* fs.makeTempDirectoryScoped();
  yield* fs.writeFileString(
    `${homePath}/models_cache.json`,
    JSON.stringify({ fetched_at: DateTime.formatIso(yield* DateTime.now) }),
  );
  const output = yield* Queue.unbounded<Uint8Array>();
  const requests = new Map(
    yield* Effect.forEach(
      ["account/read", "skills/list", "model/list/1", "model/list/2", "account/rateLimits/read"],
      (method) =>
        Deferred.make<string | number>().pipe(Effect.map((signal) => [method, signal] as const)),
    ),
  );
  const stopped = yield* Deferred.make<void>();
  const reply = (id: string | number, result: unknown) =>
    Queue.offer(output, new TextEncoder().encode(`${JSON.stringify({ id, result })}\n`));
  let modelRequests = 0;
  const spawner = ChildProcessSpawner.make(() =>
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Deferred.succeed(stopped, undefined));
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
                const request = method === "model/list" ? `${method}/${++modelRequests}` : method;
                const signal = requests.get(request);
                if (signal) yield* Deferred.succeed(signal, id);
                if (hang.includes(request) || method === "account/read") return;
                if (method === "initialize") {
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
                } else if (method === "account/rateLimits/read") {
                  yield* reply(id, {
                    rateLimits: { primary: null, secondary: null, credits: null, planType: "pro" },
                  });
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
    decodeCodexSettings({ homePath, customModels: [{ slug: "custom-model" }] }),
  ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner), Effect.forkChild);
  const requested = (method: string) => Deferred.await(requests.get(method)!);
  return {
    fiber,
    requested,
    authenticate: requested("account/read").pipe(Effect.flatMap((id) => reply(id, account))),
  };
});

it.layer(NodeServices.layer)("Codex probe budget", (it) => {
  it.effect("keeps the first complete catalog when its refresh never answers", () =>
    Effect.gen(function* () {
      const probe = yield* startProbe(["model/list/2"]);
      yield* probe.authenticate;
      yield* probe.requested("model/list/2");
      yield* TestClock.adjust("20 seconds");
      const provider = yield* Fiber.join(probe.fiber);
      assert.strictEqual(provider.status, "ready");
      assert.strictEqual(provider.auth.status, "authenticated");
      assert.deepStrictEqual(
        provider.models.map((model) => model.slug),
        ["gpt-test", "custom-model"],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("warns with authentication and custom models when no catalog arrives", () =>
    Effect.gen(function* () {
      const probe = yield* startProbe(["model/list/1"]);
      yield* probe.authenticate;
      yield* probe.requested("model/list/1");
      yield* TestClock.adjust("20 seconds");
      const provider = yield* Fiber.join(probe.fiber);
      assert.strictEqual(provider.status, "warning");
      assert.strictEqual(provider.auth.status, "authenticated");
      assert.strictEqual(provider.message, "Codex did not return its model catalog in time.");
      assert.deepStrictEqual(
        provider.models.map((model) => model.slug),
        ["custom-model"],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("bounds stalled skills and usage discovery by the remaining account probe budget", () =>
    Effect.gen(function* () {
      const probe = yield* startProbe(["skills/list", "account/rateLimits/read"]);
      yield* probe.requested("account/read");
      yield* TestClock.adjust(18_500);
      yield* probe.authenticate;
      yield* probe.requested("skills/list");
      yield* probe.requested("account/rateLimits/read");
      yield* probe.requested("model/list/2");
      yield* TestClock.adjust(1_500);
      const provider = yield* Fiber.join(probe.fiber);
      assert.strictEqual(provider.status, "ready");
      assert.strictEqual(provider.auth.status, "authenticated");
      assert.deepStrictEqual(
        provider.models.map((model) => model.slug),
        ["gpt-test", "custom-model"],
      );
      assert.deepStrictEqual(provider.skills, []);
      assert.strictEqual(provider.usageLimits?.unavailable?.reason, "probeFailed");
    }).pipe(Effect.scoped),
  );

  it.effect("retains a completed probe when cleanup exceeds the work budget", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const complete = yield* Deferred.make<void>();
      const cleanupStarted = yield* Deferred.make<void>();
      const cleanupFinished = yield* Deferred.make<void>();
      const fiber = yield* checkCodexProviderStatus(decodeCodexSettings({}), () =>
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() =>
            Deferred.succeed(cleanupStarted, undefined).pipe(
              Effect.andThen(Deferred.await(cleanupFinished)),
            ),
          );
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(complete);
          return { account, version: undefined, models: [], skills: [] };
        }),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* TestClock.adjust(18_500);
      yield* Deferred.succeed(complete, undefined);
      yield* Deferred.await(cleanupStarted);
      yield* TestClock.adjust("2 seconds");
      yield* Deferred.succeed(cleanupFinished, undefined);
      const provider = yield* Fiber.join(fiber);
      assert.strictEqual(provider.status, "ready");
      assert.strictEqual(provider.auth.status, "authenticated");
    }),
  );

  it.effect("still errors when account authentication never answers", () =>
    Effect.gen(function* () {
      const probe = yield* startProbe([]);
      yield* probe.requested("account/read");
      yield* TestClock.adjust("20 seconds");
      const provider = yield* Fiber.join(probe.fiber);
      assert.strictEqual(provider.status, "error");
      assert.strictEqual(provider.auth.status, "unknown");
      assert.strictEqual(
        provider.message,
        "Timed out while checking Codex app-server provider status.",
      );
    }).pipe(Effect.scoped),
  );
});
