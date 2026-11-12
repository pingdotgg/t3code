import { describe, expect, it } from "@effect/vitest";
import { totalTokens } from "@t3tools/provider-core/server/usage";

import {
  type CodexScanState,
  codexUsageFormat,
  initialCodexScanState,
  parseCodexLine as parseCodexRecords,
} from "./codexUsage.ts";

function parseCodexLine(line: string, state: CodexScanState) {
  const records = parseCodexRecords(line, state);
  expect(records.length).toBeLessThanOrEqual(1);
  return records[0] ?? null;
}



describe("parseCodexLine", () => {
  const sessionMeta = JSON.stringify({
    type: "session_meta",
    timestamp: "2026-08-01T05:17:41.289Z",
    payload: { type: "session_meta", id: "019fbbc1-b12c-7360-a685-28c181f0025f" },
  });
  const turnContext = JSON.stringify({
    type: "turn_context",
    timestamp: "2026-08-01T05:17:42.694Z",
    payload: { type: "turn_context", model: "gpt-5.6-sol" },
  });
  const tokenCount = (inputTokens: number, cached: number, output: number, reasoning: number) =>
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-08-01T05:17:49.919Z",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: inputTokens,
            cached_input_tokens: cached,
            cache_write_input_tokens: 0,
            output_tokens: output,
            reasoning_output_tokens: reasoning,
          },
        },
      },
    });
  const counters = (input: number, output: number) => ({
    input_tokens: input,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: input + output,
  });
  const counted = (last: unknown, total?: unknown, extra = {}) =>
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-08-01T05:17:49.919Z",
      payload: {
        type: "token_count",
        info: { last_token_usage: last, total_token_usage: total, ...extra },
      },
    });

  it("retains initial tier evidence only for the own OpenAI session and exact context until native settings arrive", () => {
    const meta = (id: string, model_provider?: string) =>
      JSON.stringify({ type: "session_meta", payload: { id, model_provider } });
    const context = (turn_id?: string, model?: string) =>
      JSON.stringify({ type: "turn_context", payload: { turn_id, model } });
    for (const provider of ["openai", "t3", "custom", undefined]) {
      const state = initialCodexScanState();
      parseCodexLine(meta("own-session", provider), state);
      parseCodexLine(meta("ancestor", provider === "openai" ? "custom" : "openai"), state);
      parseCodexLine(context("first-turn", "gpt-6-astra"), state);
      const first = parseCodexLine(tokenCount(100, 0, 1, 0), state);
      expect(first).toMatchObject({
        sessionId: "own-session",
        model: "gpt-6-astra",
        speed: "standard",
      });
      if (provider === "openai") {
        expect(first).toHaveProperty("unresolvedServiceTierTurnId", "first-turn");
      } else {
        expect(first).not.toHaveProperty("unresolvedServiceTierTurnId");
      }

      parseCodexLine(context(undefined, "gpt-6-astra"), state);
      expect(parseCodexLine(tokenCount(100, 0, 2, 0), state)).not.toHaveProperty(
        "unresolvedServiceTierTurnId",
      );
      parseCodexLine(context("missing-model"), state);
      expect(parseCodexLine(tokenCount(100, 0, 3, 0), state)).not.toHaveProperty(
        "unresolvedServiceTierTurnId",
      );
      parseCodexLine(context("next-turn", "gpt-6-astra"), state);
      const next = parseCodexLine(tokenCount(100, 0, 4, 0), state);
      if (provider === "openai") {
        expect(next).toHaveProperty("unresolvedServiceTierTurnId", "next-turn");
      } else {
        expect(next).not.toHaveProperty("unresolvedServiceTierTurnId");
      }
    }

    for (const service_tier of ["standard", "", undefined, "priority", "ultrafast"]) {
      const state = initialCodexScanState();
      parseCodexLine(meta("own-session", "openai"), state);
      parseCodexLine(context("first-turn", "gpt-6-astra"), state);
      expect(parseCodexLine(tokenCount(100, 0, 1, 0), state)).toHaveProperty(
        "unresolvedServiceTierTurnId",
        "first-turn",
      );
      parseCodexLine(
        JSON.stringify({
          type: "event_msg",
          payload: { type: "thread_settings_applied", thread_settings: { service_tier } },
        }),
        state,
      );
      for (const output of [2, 3]) {
        parseCodexLine(context(`native-turn-${output}`, "gpt-6-astra"), state);
        const record = parseCodexLine(tokenCount(100, 0, output, 0), state);
        expect(record?.speed).toBe(
          service_tier === "priority"
            ? "fast"
            : service_tier === "ultrafast"
              ? "ultrafast"
              : "standard",
        );
        expect(record).not.toHaveProperty("unresolvedServiceTierTurnId");
      }
    }
  });
  describe("forked rollouts", () => {
    const meta = (overrides: {
      id: string;
      timestamp: string;
      forkedFromId?: string;
      spawnParentId?: string;
    }) =>
      JSON.stringify({
        type: "session_meta",
        timestamp: overrides.timestamp,
        payload: {
          type: "session_meta",
          id: overrides.id,
          ...(overrides.forkedFromId === undefined
            ? {}
            : { forked_from_id: overrides.forkedFromId }),
          ...(overrides.spawnParentId === undefined
            ? {}
            : {
                source: {
                  subagent: { thread_spawn: { parent_thread_id: overrides.spawnParentId } },
                },
              }),
        },
      });
    const stamped = (timestamp: string, line: string) => {
      const parsed = JSON.parse(line) as { timestamp: string };
      parsed.timestamp = timestamp;
      return JSON.stringify(parsed);
    };

    it("drops the re-stamped copied burst and keeps the first real event", () => {
      const state = initialCodexScanState();
      const forkInstant = "2026-08-01T05:00:00.000Z";
      parseCodexLine(meta({ id: "child", timestamp: forkInstant, forkedFromId: "parent" }), state);
      parseCodexLine(meta({ id: "parent", timestamp: forkInstant }), state);
      parseCodexLine(stamped(forkInstant, turnContext), state);

      expect(
        parseCodexLine(
          stamped("2026-08-01T05:00:00.001Z", counted(counters(100, 10), counters(100, 10))),
          state,
        ),
      ).toBeNull();
      expect(
        parseCodexLine(
          stamped("2026-08-01T05:00:00.002Z", counted(counters(200, 20), counters(300, 30))),
          state,
        ),
      ).toBeNull();

      const real = parseCodexLine(
        stamped("2026-08-01T05:00:06.000Z", counted(counters(200, 20), counters(500, 50))),
        state,
      );
      expect(real).not.toBeNull();
      expect(real?.sessionId).toBe("child");
      expect(real?.totals.outputTokens).toBe(20);

      const next = parseCodexLine(
        stamped("2026-08-01T05:00:06.100Z", counted(counters(400, 40), counters(900, 90))),
        state,
      );
      expect(next).not.toBeNull();
      expect(codexUsageFormat.readMalformedRecords?.(state)).toBe(0);
    });

    it("recognizes subagent spawns without forked_from_id", () => {
      const state = initialCodexScanState();
      const spawnInstant = "2026-08-01T05:00:00.000Z";
      parseCodexLine(
        meta({ id: "child", timestamp: spawnInstant, spawnParentId: "parent" }),
        state,
      );
      parseCodexLine(stamped(spawnInstant, turnContext), state);
      expect(
        parseCodexLine(stamped("2026-08-01T05:00:00.001Z", tokenCount(100, 0, 10, 0)), state),
      ).toBeNull();
    });

    it("does not suppress anything in a rollout that is not a fork", () => {
      const state = initialCodexScanState();
      parseCodexLine(meta({ id: "root", timestamp: "2026-08-01T05:00:00.000Z" }), state);
      parseCodexLine(stamped("2026-08-01T05:00:00.100Z", turnContext), state);
      const record = parseCodexLine(
        stamped("2026-08-01T05:00:00.200Z", tokenCount(100, 0, 10, 0)),
        state,
      );
      expect(record).not.toBeNull();
    });

    it("forgets the old sequence start when a copied zero baseline rebases the counters", () => {
      const state = initialCodexScanState();
      const forkInstant = "2026-08-01T05:00:00.000Z";
      const request = counters(100, 20);
      const billed = (line: string) => {
        const record = parseCodexLine(line, state);
        return record === null ? 0 : totalTokens(record.totals);
      };
      parseCodexLine(stamped("2026-08-01T04:59:00.000Z", turnContext), state);
      const first = billed(stamped("2026-08-01T04:59:01.000Z", counted(request, request)));
      parseCodexLine(meta({ id: "child", timestamp: forkInstant, forkedFromId: "parent" }), state);
      const copied = billed(
        stamped(
          "2026-08-01T05:00:00.001Z",
          counted({ ...counters(0, 0), total_tokens: 26387 }, counters(0, 0)),
        ),
      );
      const afterBurst = billed(stamped("2026-08-01T05:00:06.000Z", counted(request, request)));
      const next = billed(
        stamped("2026-08-01T05:00:06.100Z", counted(counters(30, 5), counters(130, 25))),
      );

      expect({
        processed: [first, copied, afterBurst, next],
        skipped: codexUsageFormat.readMalformedRecords?.(state),
      }).toEqual({ processed: [120, 0, 120, 35], skipped: 0 });
    });

    it("bills the child's first request when its turn is interrupted before any snapshot", () => {
      const state = initialCodexScanState();
      const forkInstant = "2026-08-01T05:00:00.000Z";
      const request = (timestamp: string, usage: unknown) =>
        JSON.stringify({ type: "token_usage_record", timestamp, payload: { usage } });
      const billed = [
        meta({ id: "child", timestamp: forkInstant, forkedFromId: "parent" }),
        stamped(forkInstant, turnContext),
        request("2026-08-01T05:00:00.001Z", counters(100, 20)),
        stamped("2026-08-01T05:00:00.001Z", counted(counters(100, 20), counters(100, 20))),
        request("2026-08-01T05:00:06.000Z", counters(150, 10)),
        request("2026-08-01T05:00:10.000Z", counters(200, 30)),
        stamped("2026-08-01T05:00:10.000Z", counted(counters(200, 30), counters(450, 60))),
      ].flatMap((line) => parseCodexRecords(line, state));

      expect({
        processed: billed.map((record) => totalTokens(record.totals)),
        skipped: codexUsageFormat.readMalformedRecords?.(state),
      }).toEqual({ processed: [160, 230], skipped: 0 });
    });
  });
});

