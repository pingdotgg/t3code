import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as ConsoleService from "effect/Console";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as Sse from "effect/unstable/encoding/Sse";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { Gateway } from "./fixtures/Gateway.ts";
import LanguageModelTestWorker from "./fixtures/LanguageModelWorker.ts";

// Fresh `workers.dev` URLs return non-200 (404 / 500 "Script not
// found") for a few seconds while the edge propagates. Each test uses
// `HttpClient.filterStatusOk(yield* HttpClient.HttpClient)` so the
// existing `Effect.retry` rides through these by converting the
// bad-status response into a retryable Effect failure.

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const Stack = Alchemy.Stack(
  "AiGatewayLanguageModelStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* LanguageModelTestWorker;
    const gateway = yield* Gateway;
    return {
      gatewayId: gateway.gatewayId,
      url: worker.url.as<string>(),
    };
  }),
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

type StreamPart = {
  type: string;
  id?: string;
  name?: string;
  delta?: string;
  reason?: string;
  usage?: {
    inputTokens?: { total?: number };
    outputTokens?: { total?: number };
  };
};

const parseSse = (sse: string): ReadonlyArray<StreamPart> =>
  sse
    .split("\n\n")
    .map((frame) => frame.replace(/^data:\s*/, "").trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as StreamPart);

test(
  "deployed worker generates text via AiGateway-backed LanguageModel",
  Effect.gen(function* () {
    const out = yield* stack;
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);

    const res = yield* client
      .get(`${out.url}/generate?prompt=${encodeURIComponent("Say pong.")}`)
      .pipe(
        Effect.retry({
          schedule: Schedule.exponential("500 millis"),
          times: 10,
        }),
      );
    expect(res.status).toBe(200);

    const body = (yield* res.json) as {
      text: string;
      finishReason: string;
      usage: {
        inputTokens: number | undefined;
        outputTokens: number | undefined;
      };
    };

    expect(typeof body.text).toBe("string");
    expect(body.text.length).toBeGreaterThan(0);
    // Refactor invariant: `mapUsage` must populate both input and output
    // tokens from Workers AI's `prompt_tokens` / `completion_tokens` fields.
    expect(body.usage.inputTokens).toBeGreaterThan(0);
    expect(body.usage.outputTokens).toBeGreaterThan(0);
    // Refactor invariant: a normal completion maps to `stop`, not `unknown` /
    // `other` / `error`.
    expect(body.finishReason).toBe("stop");
  }).pipe(logLevel),
  { timeout: 180_000 },
);

test(
  "deployed worker streams text via AiGateway-backed LanguageModel",
  Effect.gen(function* () {
    const out = yield* stack;
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);

    // The AI-Gateway-backed model can answer 200 with an empty SSE on a cold
    // or transient call (no tokens streamed), which `filterStatusOk` does not
    // catch. Fold the parse into the retried effect and fail on an empty /
    // unfinished stream so the same backoff rides out the blip.
    const parts = yield* client
      .get(`${out.url}/stream?prompt=${encodeURIComponent("Say pong.")}`)
      .pipe(
        Effect.flatMap((res) => res.text),
        Effect.map(parseSse),
        Effect.flatMap((parts) =>
          parts.some((p) => p.type === "text-delta") &&
          parts.some((p) => p.type === "finish")
            ? Effect.succeed(parts)
            : Effect.fail(new Error("AI stream not ready: empty/unfinished")),
        ),
        Effect.retry({
          schedule: Schedule.exponential("500 millis"),
          times: 10,
        }),
      );

    const text = parts
      .filter((p) => p.type === "text-delta")
      .map((p) => p.delta ?? "")
      .join("");
    const finish = parts.find((p) => p.type === "finish");

    expect(parts.length).toBeGreaterThan(0);
    expect(text.length).toBeGreaterThan(0);
    expect(finish).toBeDefined();
  }).pipe(logLevel),
  { timeout: 180_000 },
);

test(
  "streamed parts respect ordering: text-start → text-delta+ → text-end → finish",
  Effect.gen(function* () {
    const out = yield* stack;
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);

    // Same cold/transient empty-SSE hazard as above — retry until the stream
    // actually carries the structural parts this test asserts ordering over.
    const parts = yield* client
      .get(`${out.url}/stream?prompt=${encodeURIComponent("Say pong.")}`)
      .pipe(
        Effect.flatMap((res) => res.text),
        Effect.map(parseSse),
        Effect.flatMap((parts) =>
          parts.some((p) => p.type === "text-delta") &&
          parts.some((p) => p.type === "finish")
            ? Effect.succeed(parts)
            : Effect.fail(new Error("AI stream not ready: empty/unfinished")),
        ),
        Effect.retry({
          schedule: Schedule.exponential("500 millis"),
          times: 10,
        }),
      );

    const indexOfType = (type: string) =>
      parts.findIndex((p) => p.type === type);
    const lastIndexOfType = (type: string) => {
      for (let i = parts.length - 1; i >= 0; i--) {
        if (parts[i]!.type === type) return i;
      }
      return -1;
    };

    // Refactor invariant: `emitTextDelta` opens a text-start before the first
    // text-delta, `finalizeStream` emits text-end before the final finish.
    const startIdx = indexOfType("text-start");
    const firstDeltaIdx = indexOfType("text-delta");
    const lastDeltaIdx = lastIndexOfType("text-delta");
    const endIdx = indexOfType("text-end");
    const finishIdx = indexOfType("finish");

    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(firstDeltaIdx).toBeGreaterThan(startIdx);
    expect(endIdx).toBeGreaterThan(lastDeltaIdx);
    expect(finishIdx).toBe(parts.length - 1);
    expect(finishIdx).toBeGreaterThan(endIdx);

    // Exactly one text segment was opened and closed.
    expect(parts.filter((p) => p.type === "text-start")).toHaveLength(1);
    expect(parts.filter((p) => p.type === "text-end")).toHaveLength(1);
  }).pipe(logLevel),
  { timeout: 180_000 },
);

test.skipIf(!process.env.DEBUG_RAW_STREAM)(
  "DEBUG: dump raw Workers AI SSE stream",
  Effect.gen(function* () {
    const out = yield* stack;
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
    // Through the Console SERVICE so the runner captures it per-test (raw
    // fd writes bypass capture and corrupt the reporter/TUI).
    const console = yield* ConsoleService.Console;
    const print = (s: string) => console.log(s);

    for (const includeUsage of ["0", "1"] as const) {
      const res = yield* client
        .get(
          `${out.url}/raw-stream?include_usage=${includeUsage}&prompt=${encodeURIComponent("Say pong.")}`,
        )
        .pipe(
          Effect.retry({
            schedule: Schedule.exponential("500 millis"),
            times: 10,
          }),
        );
      print(`\n=== include_usage=${includeUsage} ===\n`);
      print(yield* res.text);
      print("\n=== end ===\n");
    }

    const toolRes = yield* client
      .get(
        `${out.url}/raw-tool-stream?prompt=${encodeURIComponent("What's the weather in Seattle?")}`,
      )
      .pipe(
        Effect.retry({
          schedule: Schedule.exponential("500 millis"),
          times: 10,
        }),
      );
    print(`\n=== raw tool stream ===\n`);
    print(yield* toolRes.text);
    print("\n=== end tool stream ===\n");
  }).pipe(logLevel),
  { timeout: 180_000 },
);

test(
  "stream finish part reports real token counts and a terminal reason",
  Effect.gen(function* () {
    const out = yield* stack;
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);

    const res = yield* client
      .get(
        `${out.url}/stream?prompt=${encodeURIComponent("Say the word 'pong' and nothing else.")}`,
      )
      .pipe(
        Effect.retry({
          schedule: Schedule.exponential("500 millis"),
          times: 10,
        }),
      );
    expect(res.status).toBe(200);

    const parts = parseSse(yield* res.text);
    const finish = parts.find((p) => p.type === "finish");
    expect(finish).toBeDefined();
    // Workers AI emits the real usage chunk and then a zero-valued
    // "terminator" usage chunk; the refactor must keep the real one (see
    // `hasNonZeroUsage` in updateChunkMeta).
    expect(finish?.usage?.inputTokens?.total).toBeGreaterThan(0);
    expect(finish?.usage?.outputTokens?.total).toBeGreaterThan(0);
    // A clean `[DONE]` falls back to "stop"; some Workers AI responses now
    // report the model's real "length" reason even for this short prompt.
    expect(["stop", "length"]).toContain(finish?.reason);
  }).pipe(logLevel),
  { timeout: 180_000 },
);

test(
  "stream emits multiple text-delta chunks for a long-form response",
  Effect.gen(function* () {
    const out = yield* stack;
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);

    const res = yield* client
      .get(
        `${out.url}/stream?prompt=${encodeURIComponent(
          "Write a short paragraph (around 80 words) about why TypeScript developers might enjoy Effect TS.",
        )}`,
      )
      .pipe(
        Effect.retry({
          schedule: Schedule.exponential("500 millis"),
          times: 10,
        }),
      );
    expect(res.status).toBe(200);

    const parts = parseSse(yield* res.text);
    const deltas = parts.filter((p) => p.type === "text-delta");
    // Refactor invariant: each model SSE chunk produces a text-delta — so a
    // long response should produce many. A single fused delta would mean we
    // accidentally buffered the stream.
    expect(deltas.length).toBeGreaterThan(3);
    const total = deltas.map((p) => p.delta ?? "").join("").length;
    expect(total).toBeGreaterThan(20);
  }).pipe(logLevel),
  { timeout: 180_000 },
);

// `persisted chat survives across DO invocations` exercises the
// /chat?id=... route which is wired by `ChatAgent` from the Agent
// slice. The fixture in this slice (`LanguageModelWorker`) does not
// include that route — the test re-activates in the Agent PR.
test.skip(
  "persisted chat survives across DO invocations",
  Effect.gen(function* () {
    const out = yield* stack;
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
    const id = `test-${Date.now()}`;

    const r1 = yield* client
      .get(
        `${out.url}/chat?id=${id}&prompt=${encodeURIComponent("My name is Sam. Remember it.")}`,
      )
      .pipe(
        Effect.retry({
          schedule: Schedule.exponential("500 millis"),
          times: 10,
        }),
      );
    if (r1.status !== 200) {
      console.error("turn1 error body:", yield* r1.text);
    }
    expect(r1.status).toBe(200);
    const b1 = (yield* r1.json) as { text: string; turns: number };
    expect(b1.turns).toBeGreaterThanOrEqual(2);

    const r2 = yield* client
      .get(
        `${out.url}/chat?id=${id}&prompt=${encodeURIComponent("What is my name? Answer with just the name.")}`,
      )
      .pipe(
        Effect.retry({
          schedule: Schedule.exponential("500 millis"),
          times: 10,
        }),
      );
    expect(r2.status).toBe(200);
    const b2 = (yield* r2.json) as { text: string; turns: number };

    expect(b2.text.toLowerCase()).toContain("sam");
    expect(b2.turns).toBeGreaterThanOrEqual(4);
  }).pipe(logLevel),
  { timeout: 240_000 },
);

test(
  "deployed worker invokes a tool via AiGateway-backed LanguageModel",
  Effect.gen(function* () {
    const out = yield* stack;
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);

    const res = yield* client
      .get(
        `${out.url}/tool?prompt=${encodeURIComponent(
          "What's the weather in San Francisco?",
        )}`,
      )
      .pipe(
        Effect.retry({
          schedule: Schedule.exponential("500 millis"),
          times: 10,
        }),
      );
    if (res.status !== 200) {
      console.error("tool error body:", yield* res.text);
    }
    expect(res.status).toBe(200);

    const body = (yield* res.json) as {
      text: string;
      finishReason: string;
      toolCalls: Array<{
        id: string;
        name: string;
        params: { city: string };
      }>;
      toolResults: Array<{
        id: string;
        name: string;
        result: { city: string; temperatureF: number; condition: string };
        isFailure: boolean;
      }>;
    };

    expect(body.toolCalls.length).toBeGreaterThan(0);
    const call = body.toolCalls[0]!;
    expect(call.name).toBe("get_weather");
    expect(typeof call.params.city).toBe("string");
    expect(call.params.city.toLowerCase()).toContain("san francisco");

    expect(body.toolResults.length).toBeGreaterThan(0);
    const result = body.toolResults[0]!;
    expect(result.name).toBe("get_weather");
    expect(result.isFailure).toBe(false);
    expect(result.result.temperatureF).toBe(72);
    expect(result.result.condition).toBe("sunny");
  }).pipe(logLevel),
  { timeout: 180_000 },
);

test(
  "streams tool-call parts via AiGateway-backed LanguageModel",
  Effect.gen(function* () {
    const out = yield* stack;
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);

    const res = yield* client
      .get(
        `${out.url}/tool-stream?prompt=${encodeURIComponent(
          "What's the weather in Seattle?",
        )}`,
      )
      .pipe(
        Effect.retry({
          schedule: Schedule.exponential("500 millis"),
          times: 10,
        }),
      );
    expect(res.status).toBe(200);

    const parts = parseSse(yield* res.text);
    const toolParamsStart = parts.filter((p) => p.type === "tool-params-start");
    const toolParamsDeltas = parts.filter(
      (p) => p.type === "tool-params-delta",
    );
    const toolParamsEnd = parts.filter((p) => p.type === "tool-params-end");

    expect(toolParamsStart.length).toBeGreaterThan(0);
    expect(toolParamsStart[0]?.name).toBe("get_weather");
    expect(toolParamsDeltas.length).toBeGreaterThan(0);

    // Refactor invariant: `finalizeStream` closes any tool calls still open
    // when the stream ends, emitting one `tool-params-end` per opened call.
    expect(toolParamsEnd.length).toBe(toolParamsStart.length);
    // Each start is matched to an end by id.
    const startIds = new Set(toolParamsStart.map((p) => p.id));
    const endIds = new Set(toolParamsEnd.map((p) => p.id));
    expect(endIds).toEqual(startIds);

    // Ordering: every tool-params-end comes after its corresponding start,
    // every delta with the same id falls between start and end, and finish
    // is last.
    const indexOf = (type: string, id: string | undefined) =>
      parts.findIndex((p) => p.type === type && p.id === id);
    for (const start of toolParamsStart) {
      const startIdx = indexOf("tool-params-start", start.id);
      const endIdx = indexOf("tool-params-end", start.id);
      expect(endIdx).toBeGreaterThan(startIdx);
      for (const delta of toolParamsDeltas.filter((p) => p.id === start.id)) {
        const dIdx = parts.indexOf(delta);
        expect(dIdx).toBeGreaterThan(startIdx);
        expect(dIdx).toBeLessThan(endIdx);
      }
    }
    expect(parts[parts.length - 1]?.type).toBe("finish");
  }).pipe(logLevel),
  { timeout: 180_000 },
);

test(
  "concatenated tool-params-delta payloads parse back into the requested arguments",
  Effect.gen(function* () {
    const out = yield* stack;
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);

    const res = yield* client
      .get(
        `${out.url}/tool-stream?prompt=${encodeURIComponent(
          "What's the weather in Portland?",
        )}`,
      )
      .pipe(
        Effect.retry({
          schedule: Schedule.exponential("500 millis"),
          times: 10,
        }),
      );
    expect(res.status).toBe(200);

    const parts = parseSse(yield* res.text);
    const toolParamsStart = parts.filter((p) => p.type === "tool-params-start");
    expect(toolParamsStart.length).toBeGreaterThan(0);
    const firstId = toolParamsStart[0]!.id!;

    // Refactor invariant: `handleToolDeltas` emits each `arguments` fragment
    // as a `tool-params-delta` in order; concatenating them yields a valid
    // JSON document with the originally-requested fields.
    const joined = parts
      .filter((p) => p.type === "tool-params-delta" && p.id === firstId)
      .map((p) => p.delta ?? "")
      .join("");
    const args = yield* Effect.try({
      try: () => JSON.parse(joined) as { city?: string },
      catch: (cause) =>
        new Error(
          `Invalid concatenated tool arguments ${JSON.stringify(joined)}: ${cause}`,
        ),
    });
    expect(typeof args.city).toBe("string");
    expect(args.city!.toLowerCase()).toContain("portland");
  }).pipe(logLevel),
  { timeout: 180_000 },
);

test(
  "streams Effect-native parts and prints them live",
  Effect.gen(function* () {
    const out = yield* stack;
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);

    const res = yield* client
      .get(
        `${out.url}/stream?prompt=${encodeURIComponent("Write a short haiku about Effect TS.")}`,
      )
      .pipe(
        Effect.retry({
          schedule: Schedule.exponential("500 millis"),
          times: 10,
        }),
      );
    expect(res.status).toBe(200);

    // Through the Console SERVICE: the runner buffers it per-test (the TUI
    // detail pane live-tails it), and nothing leaks into the reporter
    // output. Raw fd writes (the old fs.writeSync(2, ...)) bypass capture.
    const console = yield* ConsoleService.Console;
    const print = (s: string) => console.log(s);

    print("--- live stream begin ---");
    let collected = "";

    yield* res.stream.pipe(
      Stream.orDie,
      Stream.decodeText(),
      Stream.pipeThroughChannel(Sse.decode<never, unknown>()),
      Stream.runForEach((event) =>
        Effect.sync(() => {
          const part = JSON.parse(event.data) as {
            type: string;
            delta?: string;
            id?: string;
            reason?: string;
          };
          switch (part.type) {
            case "text-start":
              print(`[text-start id=${part.id}]\n`);
              break;
            case "text-delta":
              print(part.delta ?? "");
              collected += part.delta ?? "";
              break;
            case "text-end":
              print(`\n[text-end id=${part.id}]\n`);
              break;
            case "finish":
              print(`[finish reason=${part.reason}]\n`);
              break;
            default:
              print(`[${part.type}]\n`);
          }
        }),
      ),
    );

    print("--- live stream end ---\n");
    expect(collected.length).toBeGreaterThan(0);
  }).pipe(logLevel),
  { timeout: 180_000 },
);
