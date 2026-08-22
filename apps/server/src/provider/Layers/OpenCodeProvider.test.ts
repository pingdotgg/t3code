import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as OpenCodeRuntime from "../opencodeRuntime.ts";
import { checkOpenCodeProviderStatus } from "./OpenCodeProvider.ts";

const settings = {
  enabled: true,
  binaryPath: "opencode2",
  customModels: [],
} as const;

function runtimeLayer(input: {
  readonly responses?: Readonly<Record<string, unknown>>;
  readonly attachError?: OpenCodeRuntime.OpenCodeRuntimeFailure;
  readonly failedPaths?: ReadonlySet<string>;
  readonly paths?: Array<string>;
}) {
  const connection: OpenCodeRuntime.OpenCodeConnection = {
    url: "http://127.0.0.1:49374/",
    protocol: { promptShape: "flat" },
    request: ((method: string, path: string, _requestInput: { readonly schema: unknown }) => {
      input.paths?.push(`${method} ${path}`);
      if (input.failedPaths?.has(path)) {
        return Effect.fail(
          new OpenCodeRuntime.OpenCodeRuntimeError({
            operation: `probe${path}`,
            reason: "http-status",
            status: 404,
          }),
        );
      }
      return Effect.succeed(input.responses?.[path]);
    }) as OpenCodeRuntime.OpenCodeConnection["request"],
    globalEvents: Stream.empty,
  };
  return Layer.succeed(
    OpenCodeRuntime.OpenCodeRuntime,
    OpenCodeRuntime.OpenCodeRuntime.of({
      attach: () =>
        input.attachError ? Effect.fail(input.attachError) : Effect.succeed(connection),
    }),
  );
}

it.effect("builds model inventory from the attached OpenCode 2 service", () => {
  const paths: Array<string> = [];
  return Effect.gen(function* () {
    const snapshot = yield* checkOpenCodeProviderStatus(settings);

    NodeAssert.equal(snapshot.status, "ready");
    NodeAssert.equal(snapshot.installed, true);
    NodeAssert.equal(snapshot.version, "0.0.0-beta-17823");
    NodeAssert.equal(snapshot.auth.status, "authenticated");
    NodeAssert.deepEqual(paths.toSorted(), [
      "GET /api/agent",
      "GET /api/health",
      "GET /api/model",
      "GET /api/model/default",
      "GET /api/skill",
    ]);
    NodeAssert.deepEqual(
      snapshot.models.map((model) => ({ slug: model.slug, isDefault: model.isDefault })),
      [
        { slug: "anthropic/claude-opus-4-6", isDefault: undefined },
        { slug: "openai/gpt-5.6", isDefault: true },
      ],
    );
    const selected = snapshot.models.find((model) => model.slug === "openai/gpt-5.6");
    NodeAssert.deepEqual(
      selected?.capabilities?.optionDescriptors?.map((descriptor) => descriptor.id) ?? [],
      ["variant", "agent"],
    );
    NodeAssert.deepEqual(snapshot.skills, [
      {
        name: "ship",
        path: "/work/.agents/skills/ship/SKILL.md",
        enabled: true,
        description: "Ship a change.",
        shortDescription: "Ship a change.",
      },
    ]);
  }).pipe(
    Effect.provide(
      runtimeLayer({
        paths,
        responses: {
          "/api/health": { healthy: true, version: "0.0.0-beta-17823", pid: 42 },
          "/api/model": {
            data: [
              {
                id: "gpt-5.6",
                providerID: "openai",
                name: "GPT-5.6",
                variants: { low: {}, high: {} },
              },
              {
                id: "claude-opus-4-6",
                providerID: "anthropic",
                name: "Claude Opus 4.6",
                variants: [],
              },
            ],
          },
          "/api/model/default": {
            data: {
              id: "gpt-5.6",
              providerID: "openai",
              name: "GPT-5.6",
              variants: { low: {}, high: {} },
            },
          },
          "/api/agent": {
            data: [
              { id: "build", name: "Build" },
              { id: "explore", name: "Explore", mode: "subagent" },
            ],
          },
          "/api/skill": {
            data: [
              {
                name: "ship",
                description: "Ship a change.",
                location: "/work/.agents/skills/ship/SKILL.md",
              },
            ],
          },
        },
      }),
    ),
  );
});

it.effect("keeps core discovery ready when optional metadata endpoints fail", () =>
  Effect.gen(function* () {
    const snapshot = yield* checkOpenCodeProviderStatus(settings);

    NodeAssert.equal(snapshot.status, "ready");
    NodeAssert.equal(snapshot.installed, true);
    NodeAssert.deepEqual(
      snapshot.models.map((model) => model.slug),
      ["openai/gpt-5.6"],
    );
    NodeAssert.deepEqual(snapshot.skills, []);
    NodeAssert.deepEqual(
      snapshot.models[0]?.capabilities?.optionDescriptors?.map((descriptor) => descriptor.id) ?? [],
      [],
    );
  }).pipe(
    Effect.provide(
      runtimeLayer({
        failedPaths: new Set(["/api/model/default", "/api/agent", "/api/skill"]),
        responses: {
          "/api/health": { healthy: true, version: "0.0.0-beta-17823" },
          "/api/model": {
            data: [
              {
                id: "gpt-5.6",
                providerID: "openai",
                name: "GPT-5.6",
              },
            ],
          },
        },
      }),
    ),
  ),
);

it.effect("reports unsupported adjacent preview protocols without hanging", () =>
  Effect.gen(function* () {
    const snapshot = yield* checkOpenCodeProviderStatus(settings);

    NodeAssert.equal(snapshot.status, "error");
    NodeAssert.match(snapshot.message ?? "", /preview is not supported/i);
  }).pipe(
    Effect.provide(
      runtimeLayer({
        attachError: new OpenCodeRuntime.OpenCodeUnsupportedPreviewError({
          operation: "openapi.detect",
        }),
      }),
    ),
  ),
);

it.effect("does not report an HTTP 404 as a missing CLI", () =>
  Effect.gen(function* () {
    const snapshot = yield* checkOpenCodeProviderStatus(settings);

    NodeAssert.equal(snapshot.status, "error");
    NodeAssert.equal(snapshot.installed, true);
    NodeAssert.doesNotMatch(snapshot.message ?? "", /not installed/i);
  }).pipe(
    Effect.provide(
      runtimeLayer({
        attachError: new OpenCodeRuntime.OpenCodeRuntimeError({
          operation: "model.list",
          reason: "http-status",
          status: 404,
        }),
      }),
    ),
  ),
);

it.effect("reports a structurally missing CLI", () =>
  Effect.gen(function* () {
    const snapshot = yield* checkOpenCodeProviderStatus(settings);

    NodeAssert.equal(snapshot.status, "error");
    NodeAssert.equal(snapshot.installed, false);
    NodeAssert.match(snapshot.message ?? "", /not installed or not on PATH/i);
  }).pipe(
    Effect.provide(
      runtimeLayer({
        attachError: new OpenCodeRuntime.OpenCodeCommandNotFoundError({
          operation: "service.start",
          cause: new Error("Command was unavailable."),
        }),
      }),
    ),
  ),
);

it.effect("warns when the attached OpenCode 2 service reports unhealthy", () =>
  Effect.gen(function* () {
    const snapshot = yield* checkOpenCodeProviderStatus(settings);

    NodeAssert.equal(snapshot.status, "warning");
    NodeAssert.match(snapshot.message ?? "", /reported that it is unhealthy/i);
  }).pipe(
    Effect.provide(
      runtimeLayer({
        responses: {
          "/api/health": { healthy: false, version: "0.0.0-beta-17823" },
          "/api/model": {
            data: [
              {
                id: "gpt-5.6",
                providerID: "openai",
                name: "GPT-5.6",
              },
            ],
          },
          "/api/model/default": { data: null },
          "/api/agent": { data: [] },
          "/api/skill": { data: [] },
        },
      }),
    ),
  ),
);

it.effect("describes custom models without counting deprecated upstream providers", () => {
  const customSettings = {
    ...settings,
    customModels: ["custom/local-model"],
  };
  return Effect.gen(function* () {
    const snapshot = yield* checkOpenCodeProviderStatus(customSettings);

    NodeAssert.equal(snapshot.status, "ready");
    NodeAssert.match(snapshot.message ?? "", /custom models configured/i);
    NodeAssert.doesNotMatch(snapshot.message ?? "", /0 upstream providers/i);
  }).pipe(
    Effect.provide(
      runtimeLayer({
        responses: {
          "/api/health": { healthy: true, version: "0.0.0-beta-17823" },
          "/api/model": {
            data: [
              {
                id: "old-model",
                providerID: "legacy",
                name: "Old Model",
                status: "deprecated",
              },
            ],
          },
          "/api/model/default": { data: null },
          "/api/agent": { data: [] },
          "/api/skill": { data: [] },
        },
      }),
    ),
  );
});

it.effect("finishes the provider check when attachment is wedged", () => {
  const layer = Layer.succeed(
    OpenCodeRuntime.OpenCodeRuntime,
    OpenCodeRuntime.OpenCodeRuntime.of({ attach: () => Effect.never }),
  );
  return Effect.gen(function* () {
    const fiber = yield* checkOpenCodeProviderStatus(settings).pipe(Effect.forkScoped);
    yield* Effect.yieldNow;
    yield* TestClock.adjust("15 seconds");
    const snapshot = yield* Fiber.join(fiber);

    NodeAssert.equal(snapshot.status, "error");
    NodeAssert.match(snapshot.message ?? "", /discovery timed out/i);
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(layer, TestClock.layer())));
});
