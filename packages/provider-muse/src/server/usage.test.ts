import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId } from "@t3tools/contracts";
import { totalTokens } from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { it } from "@effect/vitest";
import { describe, expect, vi } from "vite-plus/test";
import { MuseSettings } from "../settings.ts";
import * as MuseSdk from "./sdk.ts";
import * as MuseUsageHome from "./MuseUsageHome.ts";
import { museUsageFormat, museUsageReader } from "./usage.ts";

vi.mock("./sdk.ts", { spy: true });

const entry = () => ({
  schema_version: 1,
  record_type: "event",
  payload_type: "runtime.session",
  payload_schema_version: 1,
  id: "envelope-1",
  recorded_at: 1_785_578_400_123_456,
  stream: { kind: "session", id: "session-1" },
  payload: {
    source_run_record_id: "inference-1",
    event: {
      kind: "model_completed",
      model: "muse-wonder-full-1.0",
      usage: {
        input_tokens: 100,
        cached_tokens: 60,
        cache_read_tokens: 60,
        cache_write_tokens: 10,
        output_tokens: 20,
        reasoning_tokens: 8,
      },
    },
  },
});
const decodeSettings = Schema.decodeSync(MuseSettings);
const parse = (value: unknown) => museUsageFormat.parseLine(JSON.stringify(value), undefined);

it("normalizes inclusive cache and reasoning counters without doubling the subsets", () => {
  const [record] = parse(entry());
  expect(record).toMatchObject({
    provider: "muse",
    timestampMs: Date.parse("2026-08-01T10:00:00.123Z"),
    sessionId: "session-1",
    model: "muse-wonder-full-1.0",
    reportedCostUsd: null,
    totals: {
      uncachedInputTokens: 30,
      cachedInputTokens: 60,
      cacheCreationTokens: 10,
      outputTokens: 20,
      reasoningTokens: 8,
    },
  });
  expect(totalTokens(record!.totals)).toBe(120);
  const value = entry();
  const { cache_read_tokens: _read, ...usage } = value.payload.event.usage;
  expect(
    parse({ ...value, payload: { ...value.payload, event: { ...value.payload.event, usage } } }),
  ).toEqual([record]);
});

it("keeps individual inference identity across copied parent/child envelopes", () => {
  const original = entry();
  const [first] = parse(original);
  const [copy] = parse({ ...original, id: "copy", stream: { kind: "session", id: "child" } });
  expect(copy?.dedupeKey).toBe(first?.dedupeKey);
  const next = entry();
  next.payload.source_run_record_id = "inference-2";
  expect(parse(next)[0]?.dedupeKey).not.toBe(first?.dedupeKey);
  const { source_run_record_id: _source, ...payload } = original.payload;
  const fallback = parse({ ...original, payload });
  expect(fallback[0]?.dedupeKey).toBe(JSON.stringify(["muse", original.id]));
});

it("includes automated review inference models and ignores workflow and telemetry rollups", () => {
  const value = entry();
  expect(
    parse({
      ...value,
      payload: {
        ...value.payload,
        event: {
          ...value.payload.event,
          kind: "automated_review_completed",
          model: { model_id: "review-model", provider_id: "meta" },
        },
      },
    })[0]?.model,
  ).toBe("review-model");
  for (const kind of [
    "workflow_completed",
    "goal_usage_attribution",
    "turn_completed",
    "usage_summary",
  ]) {
    expect(
      parse({ ...value, payload: { ...value.payload, event: { ...value.payload.event, kind } } }),
    ).toEqual([]);
  }
  expect(parse({ ...value, payload_type: "run.telemetry" })).toEqual([]);
  expect(parse({ ...value, record_type: "snapshot" })).toEqual([]);
  expect(parse({ ...value, stream: { kind: "run", id: "run-1" } })).toEqual([]);
});

it("includes native version 3 automated review inferences", () => {
  const value = entry();
  const review = {
    ...value,
    payload_schema_version: 3,
    payload: {
      ...value.payload,
      event: {
        ...value.payload.event,
        kind: "automated_review_completed",
        model: { provider_id: "meta", model_id: "review-model", reasoning_effort: "high" },
        usage: {
          input_tokens: 100,
          cached_input_tokens: 60,
          output_tokens: 20,
          reasoning_tokens: 8,
        },
      },
    },
  };
  expect(parse(review)).toEqual([
    {
      ...parse(value)[0],
      model: "review-model",
      totals: {
        uncachedInputTokens: 40,
        cachedInputTokens: 60,
        cacheCreationTokens: 0,
        outputTokens: 20,
        reasoningTokens: 8,
      },
    },
  ]);
  expect(museUsageFormat.parseProjected(review, undefined)).toEqual(parse(review));
});

it("handles malformed and partial data and rejects unsupported timestamps or schemas", () => {
  expect(museUsageFormat.parseLine("not json", undefined)).toEqual([]);
  expect(museUsageFormat.parseLine(JSON.stringify(entry()).slice(0, -1), undefined)).toEqual([]);
  for (const recorded_at of [NaN, Infinity, -1, "1785578400123456", Number.MAX_SAFE_INTEGER + 1]) {
    expect(museUsageFormat.parseProjected({ ...entry(), recorded_at }, undefined)).toEqual([]);
  }
  expect(parse({ ...entry(), schema_version: 2 })).toEqual([]);
  expect(parse({ ...entry(), payload_schema_version: 2 })).toEqual([]);
  expect(parse({ ...entry(), id: "" })).toEqual([]);
  expect(parse({ ...entry(), payload: { event: { kind: "model_completed" } } })).toEqual([]);
  const value = entry();
  const result = parse({
    ...value,
    payload: {
      event: {
        ...value.payload.event,
        usage: {
          input_tokens: 10,
          cache_read_tokens: 20,
          cache_write_tokens: 8,
          output_tokens: 3,
          reasoning_tokens: 9,
        },
      },
    },
  });
  expect(result[0]?.totals).toEqual({
    uncachedInputTokens: 0,
    cachedInputTokens: 10,
    cacheCreationTokens: 0,
    outputTokens: 3,
    reasoningTokens: 3,
  });
  expect(
    parse({
      ...value,
      payload: {
        event: { ...value.payload.event, usage: { input_tokens: -5, output_tokens: "20" } },
      },
    }),
  ).toEqual([]);
});

describe("Muse history discovery", () => {
  it.effect.each([undefined, "/custom/xdg-data"])(
    "uses the initialized home with XDG_DATA_HOME=%s and closes without starting a session",
    (xdg) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const close = vi.fn(async () => {});
        using create = vi.spyOn(MuseSdk, "createMuseSdkHostEffect").mockReturnValue(
          Effect.succeed({
            initializeResult: { grantedCapabilities: [], museHome: "/native/configured-home" },
            close,
          } as unknown as MuseSdk.MuseSdkHost),
        );
        if (museUsageReader.kind !== "transcripts") throw new Error("Expected a transcript reader");
        const directories = yield* museUsageReader.directories({
          instanceId: ProviderInstanceId.make("muse-other"),
          configured: true,
          config: decodeSettings({ binaryPath: "~/bin/custom-muse" }),
          environment: { XDG_DATA_HOME: xdg, MUSE_NO_AUTO_UPDATE: "0" },
        });
        expect(directories).toEqual([
          { dir: path.join("/native/configured-home", "sessions"), fileName: "session.jsonl" },
        ]);
        expect(create).toHaveBeenCalledWith({
          binaryPath: path.join("/test-home", "bin/custom-muse"),
          environment: {
            PATH: "/host/bin",
            XDG_DATA_HOME: xdg ?? "/host/data",
            MUSE_NO_AUTO_UPDATE: "1",
          },
          readOnly: true,
          startupTimeoutMs: 5_000,
        });
        expect(close).toHaveBeenCalledOnce();
      }).pipe(
        Effect.provide([NodeServices.layer, MuseUsageHome.layer]),
        Effect.provideService(HostProcess.HomeDirectory, "/test-home"),
        Effect.provideService(HostProcess.Environment, {
          PATH: "/host/bin",
          XDG_DATA_HOME: "/host/data",
        }),
      ),
  );

  it.effect("does not guess a directory when initialization fails", () =>
    Effect.gen(function* () {
      using _create = vi.spyOn(MuseSdk, "createMuseSdkHostEffect").mockReturnValue(
        Effect.try(() => {
          throw new Error("not installed");
        }),
      );
      if (museUsageReader.kind !== "transcripts") throw new Error("Expected a transcript reader");
      const directories = yield* museUsageReader.directories({
        instanceId: ProviderInstanceId.make("muse"),
        configured: false,
        config: undefined,
        environment: {},
      });
      expect(directories).toEqual([]);
    }).pipe(Effect.provide([NodeServices.layer, MuseUsageHome.layer])),
  );

  it.effect(
    "reuses discovery across accounts, date scans, and equivalent effective environments",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const close = vi.fn(async () => {});
        using create = vi.spyOn(MuseSdk, "createMuseSdkHostEffect").mockReturnValue(
          Effect.succeed({
            initializeResult: { museHome: "/native/home" },
            close,
          } as unknown as MuseSdk.MuseSdkHost),
        );
        if (museUsageReader.kind !== "transcripts") throw new Error("Expected a transcript reader");
        const instance = {
          instanceId: ProviderInstanceId.make("disabled-muse"),
          configured: true,
          config: decodeSettings({ binaryPath: "~/bin/muse", enabled: false }),
          environment: { PATH: "/bin", XDG_DATA_HOME: "/data" },
        };
        const first = yield* museUsageReader.directories(instance);
        const second = yield* museUsageReader.directories({
          ...instance,
          instanceId: ProviderInstanceId.make("another-account"),
          config: decodeSettings({
            binaryPath: path.join("/test-home", "bin/muse"),
            enabled: true,
          }),
          environment: {
            XDG_DATA_HOME: "/data",
            PATH: "/bin",
            UNUSED: undefined,
            META_API_KEY: "ignored",
          },
        });
        expect(second).toEqual(first);
        expect(first).toEqual([
          { dir: path.join("/native/home", "sessions"), fileName: "session.jsonl" },
        ]);
        expect(create).toHaveBeenCalledOnce();
        expect(close).toHaveBeenCalledOnce();
      }).pipe(
        Effect.provide([NodeServices.layer, MuseUsageHome.layer]),
        Effect.provideService(HostProcess.HomeDirectory, "/test-home"),
        Effect.provideService(HostProcess.Environment, {}),
      ),
  );

  it.effect(
    "rediscovers when the binary, instance environment, or inherited environment changes",
    () =>
      Effect.gen(function* () {
        using create = vi.spyOn(MuseSdk, "createMuseSdkHostEffect").mockImplementation((options) =>
          Effect.succeed({
            initializeResult: { museHome: options.environment?.XDG_DATA_HOME },
            close: async () => {},
          } as unknown as MuseSdk.MuseSdkHost),
        );
        if (museUsageReader.kind !== "transcripts") throw new Error("Expected a transcript reader");
        const instance = {
          instanceId: ProviderInstanceId.make("muse"),
          configured: true,
          config: undefined,
          environment: {},
        };
        const first = yield* museUsageReader.directories(instance);
        expect(
          yield* museUsageReader.directories({
            ...instance,
            config: decodeSettings({ binaryPath: "custom-muse" }),
          }),
        ).toEqual(first);
        const changed = yield* museUsageReader.directories({
          ...instance,
          environment: { XDG_DATA_HOME: "/other-data" },
        });
        expect(changed).not.toEqual(first);
        const inherited = yield* museUsageReader
          .directories(instance)
          .pipe(
            Effect.provideService(HostProcess.Environment, { XDG_DATA_HOME: "/new-host-data" }),
          );
        expect(inherited).not.toEqual(first);
        expect(inherited).not.toEqual(changed);
        expect(create).toHaveBeenCalledTimes(4);
      }).pipe(
        Effect.provide([NodeServices.layer, MuseUsageHome.layer]),
        Effect.provideService(HostProcess.Environment, { XDG_DATA_HOME: "/host-data" }),
      ),
  );

  it.effect("shares pending initialization across concurrent directory reads", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const ready = yield* Deferred.make<MuseSdk.MuseSdkHost>();
      using create = vi
        .spyOn(MuseSdk, "createMuseSdkHostEffect")
        .mockImplementation(() =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(ready))),
        );
      const close = vi.fn(async () => {});
      if (museUsageReader.kind !== "transcripts") throw new Error("Expected a transcript reader");
      const instance = {
        instanceId: ProviderInstanceId.make("muse"),
        configured: true,
        config: undefined,
        environment: {},
      };
      const reads = yield* Effect.all(
        [museUsageReader.directories(instance), museUsageReader.directories(instance)],
        { concurrency: "unbounded" },
      ).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Deferred.succeed(ready, {
        initializeResult: { museHome: "/native/home" },
        close,
      } as unknown as MuseSdk.MuseSdkHost);
      const [first, second] = yield* Fiber.join(reads);
      expect(first).toEqual(second);
      expect(first).toHaveLength(1);
      expect(create).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
    }).pipe(Effect.provide([NodeServices.layer, MuseUsageHome.layer])),
  );

  it.effect("briefly caches failed discovery and retries after installation recovers", () =>
    Effect.gen(function* () {
      using create = vi
        .spyOn(MuseSdk, "createMuseSdkHostEffect")
        .mockReturnValueOnce(
          Effect.try(() => {
            throw new Error("not installed");
          }),
        )
        .mockReturnValue(
          Effect.succeed({
            initializeResult: { museHome: "/installed/home" },
            close: async () => {},
          } as unknown as MuseSdk.MuseSdkHost),
        );
      if (museUsageReader.kind !== "transcripts") throw new Error("Expected a transcript reader");
      const instance = {
        instanceId: ProviderInstanceId.make("muse"),
        configured: false,
        config: undefined,
        environment: {},
      };
      expect(yield* museUsageReader.directories(instance)).toEqual([]);
      expect(yield* museUsageReader.directories(instance)).toEqual([]);
      expect(create).toHaveBeenCalledOnce();
      yield* TestClock.adjust("30 seconds");
      expect(yield* museUsageReader.directories(instance)).toHaveLength(1);
      expect(create).toHaveBeenCalledTimes(2);
    }).pipe(Effect.provide([NodeServices.layer, MuseUsageHome.layer])),
  );
});
