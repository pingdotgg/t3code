import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { AcpRegistrySettings } from "../settings.ts";
import {
  dshUsageFormat,
  dshUsageReader,
  isDshCommand,
  isDshInstance,
  resolveDshSessionsDir,
} from "./usage.ts";

const decodeSettings = Schema.decodeSync(AcpRegistrySettings);
const initial = () => dshUsageFormat.state!.initial();
const line = (value: unknown) => JSON.stringify(value);

describe("dsh usage", () => {
  it("records each assistant step after tracking the session and model", () => {
    const state = initial();
    expect(dshUsageFormat.parseLine(line({ type: "session", id: "sess-1" }), state)).toEqual([]);
    expect(
      dshUsageFormat.parseLine(
        line({
          type: "request/context",
          data: { provider: "openrouter", model: "deepseek/deepseek-v4.1-flash-1017" },
        }),
        state,
      ),
    ).toEqual([]);

    const records = dshUsageFormat.parseLine(
      line({
        type: "assistant/message",
        seq: 7,
        time: 1_793_523_594_633,
        data: {
          message: {
            source: { provider: "openrouter", model: "deepseek/deepseek-v4.1-flash-1017" },
          },
          usage: {
            inputTokens: 100,
            outputTokens: 20,
            cacheReadTokens: 1_000,
            cacheWriteTokens: 5,
            totalTokens: 1_120,
            thoughtTokens: 4,
          },
        },
      }),
      state,
    );

    expect(records).toEqual([
      {
        provider: "dsh",
        timestampMs: 1_793_523_594_633,
        model: "openrouter/deepseek/deepseek-v4.1-flash-1017",
        rateModel: "deepseek/deepseek-v4.1-flash-1017",
        sessionId: "sess-1",
        totals: {
          uncachedInputTokens: 100,
          cachedInputTokens: 1_000,
          cacheCreationTokens: 5,
          outputTokens: 20,
          reasoningTokens: 4,
        },
        reportedCostUsd: null,
        speed: "standard",
        dedupeKey: JSON.stringify(["dsh", "sess-1", 7]),
      },
    ]);
  });

  it("skips steps without usage, zero usage, and malformed lines", () => {
    const state = initial();
    expect(dshUsageFormat.parseLine("not json", state)).toEqual([]);
    expect(
      dshUsageFormat.parseLine(
        line({ type: "assistant/message", time: 1, data: { message: {} } }),
        state,
      ),
    ).toEqual([]);
    expect(
      dshUsageFormat.parseLine(
        line({ type: "assistant/message", time: 1, data: { usage: {} } }),
        state,
      ),
    ).toEqual([]);
  });

  it("recognizes dsh commands only when they are local", () => {
    expect(isDshCommand("dsh")).toBe(true);
    expect(isDshCommand("/usr/local/bin/dsh-acp")).toBe(true);
    expect(isDshCommand("C:\\tools\\dsh.exe")).toBe(true);
    expect(isDshCommand("node")).toBe(false);
    expect(isDshInstance(decodeSettings({ source: "local", commandPath: "dsh" }))).toBe(true);
    expect(
      isDshInstance(decodeSettings({ source: "registry", agentId: "kilo", commandPath: "dsh" })),
    ).toBe(false);
    expect(isDshInstance(undefined)).toBe(false);
  });

  it.effect("resolves DSH_HOME and the default home", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const custom = resolveDshSessionsDir({ DSH_HOME: "~/custom-dsh" }, "/home/test", path);
      const fallback = resolveDshSessionsDir({}, "/home/test", path);

      expect(custom).toBe(path.resolve("/home/test", "custom-dsh", "sessions"));
      expect(fallback).toBe(path.resolve("/home/test", ".dsh", "sessions"));
    }).pipe(Effect.provide(Path.layer)),
  );

  it.effect("returns the dsh sessions dir for local dsh instances only", () =>
    Effect.gen(function* () {
      if (dshUsageReader.kind !== "transcripts") throw new Error("expected transcripts reader");
      const path = yield* Path.Path;
      const dsh = yield* dshUsageReader.directories({
        instanceId: ProviderInstanceId.make("dsh"),
        config: decodeSettings({ source: "local", commandPath: "dsh" }),
        environment: { DSH_HOME: "/tmp/dsh-home" },
        configured: true,
      });
      expect(dsh).toEqual([{ dir: path.resolve("/tmp/dsh-home", "sessions") }]);

      const kilo = yield* dshUsageReader.directories({
        instanceId: ProviderInstanceId.make("kilo"),
        config: decodeSettings({ source: "registry", agentId: "kilo" }),
        environment: {},
        configured: true,
      });
      expect(kilo).toEqual([]);
    }).pipe(Effect.provide(Path.layer)),
  );
});
