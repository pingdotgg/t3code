import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CodexSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
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

const decodeCodexSettings = Schema.decodeSync(CodexSettings);
const decodeRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
      method: Schema.String,
    }),
  ),
);

it.effect("keeps account authentication when optional model discovery never answers", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const homePath = yield* fs.makeTempDirectoryScoped();
    const output = yield* Queue.unbounded<Uint8Array>();
    const modelRequested = yield* Deferred.make<void>();
    const stopped = yield* Deferred.make<void>();
    const killed = yield* Deferred.make<void>();
    const spawner = ChildProcessSpawner.make(() =>
      Effect.gen(function* () {
        const handle = ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Deferred.await(stopped).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
          isRunning: Deferred.isDone(stopped).pipe(Effect.map((done) => !done)),
          kill: () =>
            Deferred.succeed(killed, undefined).pipe(
              Effect.andThen(Deferred.succeed(stopped, undefined)),
              Effect.asVoid,
            ),
          unref: Effect.succeed(Effect.void),
          stdin: Sink.forEach((bytes: Uint8Array) =>
            Effect.forEach(
              new TextDecoder().decode(bytes).split("\n").filter(Boolean),
              (line) =>
                Effect.gen(function* () {
                  const { id, method } = decodeRequest(line);
                  if (method === "model/list") {
                    yield* Deferred.succeed(modelRequested, undefined);
                    return;
                  }
                  if (id === undefined || !["initialize", "account/read"].includes(method)) return;
                  const result =
                    method === "initialize"
                      ? {
                          userAgent: "codex/0.164.0",
                          codexHome: homePath,
                          platformFamily: "unix",
                          platformOs: "linux",
                        }
                      : {
                          account: {
                            type: "chatgpt",
                            email: "account@example.test",
                            planType: "pro",
                          },
                          requiresOpenaiAuth: false,
                        };
                  yield* Queue.offer(
                    output,
                    new TextEncoder().encode(`${JSON.stringify({ id, result })}\n`),
                  );
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
        yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.orDie));
        return handle;
      }),
    );
    const probe = yield* checkCodexProviderStatus(
      decodeCodexSettings({ homePath, customModels: [{ slug: "custom-model" }] }),
    ).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.forkChild,
    );
    yield* Deferred.await(modelRequested);
    yield* TestClock.adjust("20 seconds");
    const provider = yield* Fiber.join(probe);
    assert.equal(provider.status, "warning");
    assert.equal(provider.auth.status, "authenticated");
    assert.equal(provider.message, "Codex did not return its model catalog in time.");
    assert.deepEqual(
      provider.models.map((model) => model.slug),
      ["custom-model"],
    );
    assert.isTrue(yield* Deferred.isDone(killed));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

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

it("ignores custom models that shadow a preferred slug", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-sol", name: "gpt-5.6-sol", isCustom: true, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});
