import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
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

const failedUsageQuery = () =>
  ({
    initializationResult: async () => ({}),
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () =>
      Promise.reject(new Error("usage unavailable")),
  }) as ReturnType<typeof ClaudeSdk.query>;

// Stands in for the SDK. Each probe reports the Claude home it was started
// with as the account email.
const mockSdk = () =>
  Effect.gen(function* () {
    const query = vi.spyOn(ClaudeSdk, "query").mockImplementation(
      ({ options }) =>
        ({
          initializationResult: async () => ({
            account: { email: options?.env?.CLAUDE_CONFIG_DIR ?? "" },
            commands: [{ name: "review", description: "Review changes", argumentHint: "" }],
          }),
          usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
            rate_limits_available: false,
            rate_limits: null,
          }),
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
    yield* TestClock.adjust("2 minutes");
    const later = yield* cache.capabilities(input("/homes/work"));

    assert.equal(query.mock.calls.length, 1);
    assert.match(first?.email ?? "", /work$/);
    assert.deepEqual(second, first);
    // A later reader sees the probe's own time, not its read time.
    assert.deepEqual(later, first);
    assert.equal(later?.checkedAt, "1970-01-01T00:00:00.000Z");
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

// Both point at ~/.claude, but an explicit CLAUDE_CONFIG_DIR is a separate
// login to the CLI (its own keychain entry and .claude.json).
it.effect("an empty home and an explicit ~/.claude run separate probes", () =>
  Effect.gen(function* () {
    const query = yield* mockSdk();
    const cache = yield* ClaudeProbeCache.ClaudeProbeCache;

    yield* cache.capabilities(input(""));
    const explicit = yield* cache.capabilities(input("~/.claude"));

    assert.equal(query.mock.calls.length, 2);
    assert.match(explicit?.email ?? "", /\.claude$/);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("retries a first failure after 30 seconds and a repeat failure after 5 minutes", () =>
  Effect.gen(function* () {
    const query = yield* mockSdk();
    query.mockImplementationOnce(failedQuery).mockImplementationOnce(failedUsageQuery);
    const cache = yield* ClaudeProbeCache.ClaudeProbeCache;
    const read = cache.capabilities(input("/homes/work"));

    assert.equal(yield* read, undefined);
    yield* TestClock.adjust("29 seconds");
    yield* read;
    assert.equal(query.mock.calls.length, 1);

    // A failed usage read is a failure too, and this one repeats.
    yield* TestClock.adjust("1 second");
    assert.isUndefined((yield* read)?.usage);
    assert.equal(query.mock.calls.length, 2);
    yield* TestClock.adjust("4 minutes");
    yield* read;
    assert.equal(query.mock.calls.length, 2);

    yield* TestClock.adjust("1 minute");
    assert.isDefined((yield* read)?.usage);
    assert.equal(query.mock.calls.length, 3);

    // A success ends the streak, so the next failure retries soon again.
    query.mockImplementationOnce(failedQuery);
    yield* TestClock.adjust("5 minutes");
    assert.equal(yield* read, undefined);
    yield* TestClock.adjust("30 seconds");
    assert.isDefined(yield* read);
    assert.equal(query.mock.calls.length, 5);
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

it.effect("keeps every input cached across refreshes when there are many instances", () =>
  Effect.gen(function* () {
    const query = yield* mockSdk();
    const cache = yield* ClaudeProbeCache.ClaudeProbeCache;
    const homes = Array.from({ length: 100 }, (_, index) => `/homes/${index}`);
    const refresh = Effect.forEach(homes, (home) => cache.capabilities(input(home)), {
      concurrency: "unbounded",
    });

    yield* refresh;
    yield* refresh;

    assert.equal(query.mock.calls.length, homes.length);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);
