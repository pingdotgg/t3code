import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import * as ClaudeProbeCache from "./ClaudeProbeCache.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", { spy: true });

const testLayer = ClaudeProbeCache.layer.pipe(Layer.provide(NodeServices.layer));

// A fresh object per call, so sharing depends on equal inputs, not identity.
const input = (
  homePath: string,
  environment: ClaudeProbeCache.ClaudeProbeInput["environment"] = [],
): ClaudeProbeCache.ClaudeProbeInput => ({
  binaryPath: "claude",
  homePath,
  cwd: "/repo",
  environment,
});

const failedQuery = () =>
  ({
    initializationResult: () => Promise.reject(new Error("not logged in")),
  }) as ReturnType<typeof ClaudeSdk.query>;

// Stands in for the SDK. Each probe reports the Claude home it was started
// with as the account email. Probes finish once `ready` resolves.
const mockSdk = (ready: Promise<void> = Promise.resolve()) =>
  Effect.gen(function* () {
    const query = vi.spyOn(ClaudeSdk, "query").mockImplementation(
      ({ options }) =>
        ({
          initializationResult: async () => {
            await ready;
            return {
              account: { email: options?.env?.CLAUDE_CONFIG_DIR ?? "" },
              commands: [{ name: "review", description: "Review changes", argumentHint: "" }],
            };
          },
          usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () =>
            Promise.reject(new Error("usage unavailable")),
        }) as ReturnType<typeof ClaudeSdk.query>,
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));
    return query;
  });

it.effect("instances with the same probe input share one probe", () =>
  Effect.gen(function* () {
    const query = yield* mockSdk();
    const cache = yield* ClaudeProbeCache.ClaudeProbeCache;

    const [first, second] = yield* Effect.all(
      [cache.capabilities(input("/homes/work")), cache.capabilities(input("/homes/work"))],
      { concurrency: "unbounded" },
    );
    const later = yield* cache.capabilities(input("/homes/work"));

    assert.equal(query.mock.calls.length, 1);
    assert.match(first?.email ?? "", /work$/);
    assert.deepEqual(second, first);
    assert.deepEqual(later, first);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("different homes or instance env vars run separate probes", () =>
  Effect.gen(function* () {
    const query = yield* mockSdk();
    const cache = yield* ClaudeProbeCache.ClaudeProbeCache;

    const work = yield* cache.capabilities(input("/homes/work"));
    const personal = yield* cache.capabilities(input("/homes/personal"));
    yield* cache.capabilities(
      input("/homes/work", [{ name: "ANTHROPIC_API_KEY", value: "sk-test", sensitive: true }]),
    );

    assert.equal(query.mock.calls.length, 3);
    assert.match(work?.email ?? "", /work$/);
    assert.match(personal?.email ?? "", /personal$/);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("retries a failed probe after a short TTL and keeps a success longer", () =>
  Effect.gen(function* () {
    const query = yield* mockSdk();
    query.mockImplementationOnce(failedQuery);
    const cache = yield* ClaudeProbeCache.ClaudeProbeCache;

    assert.equal(yield* cache.capabilities(input("/homes/work")), undefined);
    assert.equal(yield* cache.capabilities(input("/homes/work")), undefined);
    assert.equal(query.mock.calls.length, 1);

    yield* TestClock.adjust("30 seconds");
    assert.match((yield* cache.capabilities(input("/homes/work")))?.email ?? "", /work$/);
    assert.equal(query.mock.calls.length, 2);

    yield* TestClock.adjust("1 minute");
    yield* cache.capabilities(input("/homes/work"));
    assert.equal(query.mock.calls.length, 2);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("invalidate re-probes only that input", () =>
  Effect.gen(function* () {
    const query = yield* mockSdk();
    const cache = yield* ClaudeProbeCache.ClaudeProbeCache;

    yield* cache.capabilities(input("/homes/work"));
    yield* cache.capabilities(input("/homes/personal"));
    yield* cache.invalidate(input("/homes/work"));
    yield* cache.capabilities(input("/homes/work"));
    yield* cache.capabilities(input("/homes/personal"));

    assert.equal(query.mock.calls.length, 3);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("runs at most 3 SDK probes at once", () =>
  Effect.gen(function* () {
    const { promise: released, resolve: release } = Promise.withResolvers<void>();
    const query = yield* mockSdk(released);
    const cache = yield* ClaudeProbeCache.ClaudeProbeCache;
    const homes = ["a", "b", "c", "d", "e"].map((name) => `/homes/${name}`);

    const probes = yield* Effect.forEach(homes, (home) => cache.capabilities(input(home)), {
      concurrency: "unbounded",
    }).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    assert.equal(query.mock.calls.length, 3);

    release();
    const results = yield* Fiber.join(probes);
    assert.equal(query.mock.calls.length, 5);
    assert.isTrue(results.every((result) => result !== undefined));
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);
