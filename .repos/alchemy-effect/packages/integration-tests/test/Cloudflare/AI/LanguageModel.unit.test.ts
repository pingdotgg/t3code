import { makeLanguageModel } from "@alchemy.run/cloudflare/AI/LanguageModel";
/// <reference types="@cloudflare/workers-types" />
import { describe, expect, test } from "@alchemy.run/test";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { LanguageModel, Tool, Toolkit } from "effect/ai";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

// Deterministic coverage for how the Workers AI adapter maps raw model output
// to Effect AI parts. A fake `Ai` binding replays chunk shapes recorded from
// live Workers AI models; the live matrix in `LanguageModel.test.ts` covers the
// real models themselves.

const tags = ["unit", "provider:cloudflare", "provider:cloudflare:ai", "local"];

const R1 = "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b";
const QWQ = "@cf/qwen/qwq-32b";

const GetWeather = Tool.make("get_weather", {
  parameters: Schema.Struct({ city: Schema.String }),
  success: Schema.String,
});
const Tools = Toolkit.make(GetWeather);
const ToolHandlers = Tools.toLayer({
  get_weather: ({ city }) => Effect.succeed(`Sunny in ${city}`),
});

const sse = (chunks: ReadonlyArray<unknown>) =>
  [...chunks, "[DONE]"]
    .map((c) => `data: ${typeof c === "string" ? c : JSON.stringify(c)}\n\n`)
    .join("");

/** Native Workers AI chunk: text in the top-level `response` field. */
const native = (response: string) => ({ response, tool_calls: [] });
/** OpenAI-compatible chunk. */
const openai = (delta: Record<string, unknown>) => ({
  choices: [{ index: 0, delta, finish_reason: null }],
  tool_calls: [],
});

const layerFor = (model: string, body: () => globalThis.Response) => {
  const ai = { run: async () => body() } as unknown as Ai;
  return Layer.effect(
    LanguageModel.LanguageModel,
    makeLanguageModel({ model, client: { raw: Effect.succeed(ai) } }),
  ).pipe(Layer.provide(RuntimeContext.phantom));
};

type Summary = {
  readonly reasoning: string;
  readonly text: string;
  /** Part types with consecutive deltas collapsed, e.g. `reasoning-start, reasoning-delta, …`. */
  readonly shape: ReadonlyArray<string>;
};

const stream = (
  chunks: ReadonlyArray<unknown>,
  options: { readonly model?: string; readonly tools?: boolean } = {},
) =>
  Effect.gen(function* () {
    const layer = layerFor(options.model ?? R1, () => new Response(sse(chunks)));
    const parts = yield* (
      options.tools
        ? LanguageModel.streamText({ prompt: "hi", toolkit: Tools }).pipe(
            Stream.provide(ToolHandlers),
          )
        : LanguageModel.streamText({ prompt: "hi" })
    ).pipe(Stream.provide(layer), Stream.runCollect);
    const all = Array.from(parts);
    const shape = all
      .map((p) => p.type as string)
      .filter((t, i, ts) => !(t.endsWith("-delta") && ts[i - 1] === t));
    return {
      parts: all,
      reasoning: all.flatMap((p) => (p.type === "reasoning-delta" ? [p.delta] : [])).join(""),
      text: all.flatMap((p) => (p.type === "text-delta" ? [p.delta] : [])).join(""),
      shape,
    };
  });

const generate = (message: Record<string, unknown>, model = R1) =>
  Effect.gen(function* () {
    const layer = layerFor(model, () => Response.json(message));
    const response = yield* LanguageModel.generateText({ prompt: "hi" }).pipe(
      Effect.provide(layer),
    );
    return { reasoning: response.reasoningText, text: response.text };
  });

const REASONED: ReadonlyArray<string> = [
  "reasoning-start",
  "reasoning-delta",
  "reasoning-end",
  "text-start",
  "text-delta",
  "text-end",
  "finish",
];

const expectSummary = (actual: Summary, expected: Partial<Summary>) =>
  expect({
    reasoning: actual.reasoning,
    text: actual.text,
    ...(expected.shape ? { shape: actual.shape } : {}),
  }).toEqual({ reasoning: "", text: "", ...expected });

/** Every way to cut `text` into two chunks, plus one chunk per character. */
const chunkings = (text: string): ReadonlyArray<ReadonlyArray<string>> => [
  ...Array.from({ length: text.length - 1 }, (_, i) => [text.slice(0, i + 1), text.slice(i + 1)]),
  Array.from(text),
];

describe("streamText <think> splitting", () => {
  test.effect(
    "text and reasoning stream incrementally, one delta per chunk",
    () =>
      Effect.gen(function* () {
        // The splitter only holds back a possible `<think>` prefix; anything
        // else must be released immediately, not buffered until finalize.
        const chunks = ["Hello", " <", "b>", " world"];
        const shapes: ReadonlyArray<(t: string) => unknown> = [
          native,
          (content) => openai({ content }),
        ];
        for (const shape of shapes) {
          const out = yield* stream(chunks.map(shape));
          const deltas = out.parts.flatMap((p) => (p.type === "text-delta" ? [p.delta] : []));
          expect(deltas).toEqual(chunks);
        }
        // Reasoning streams too; only a possible `</think>` prefix waits.
        const reasoning = yield* stream(
          ["<think>", "a ", "b </", "i> c", "</think>", "x"].map(native),
        );
        expect(
          reasoning.parts.flatMap((p) => (p.type === "reasoning-delta" ? [p.delta] : [])),
        ).toEqual(["a ", "b ", "</i> c"]);
        // A leading `<` waits for exactly one more chunk to rule out `<think>`.
        const lead = yield* stream(["<", "b>", "bold"].map(native));
        expect(lead.parts.flatMap((p) => (p.type === "text-delta" ? [p.delta] : []))).toEqual([
          "<b>",
          "bold",
        ]);
      }),
    { tags },
  );

  test.effect(
    "tags streamed as their own chunks (deepseek-r1-distill shape)",
    () =>
      Effect.gen(function* () {
        const out = yield* stream(
          [
            "<think>",
            "\n",
            "Pong",
            " is",
            " wanted",
            ".",
            "\n",
            "</think>",
            "\n\n",
            "Pong",
            "!",
          ].map(native),
        );
        expectSummary(out, { reasoning: "\nPong is wanted.\n", text: "Pong!", shape: REASONED });
      }),
    { tags },
  );

  test.effect(
    "block and answer in a single chunk",
    () =>
      Effect.gen(function* () {
        const out = yield* stream([native("<think>plan</think>answer")]);
        expectSummary(out, { reasoning: "plan", text: "answer", shape: REASONED });
      }),
    { tags },
  );

  test.effect(
    "whitespace before the opening tag still opens reasoning",
    () =>
      Effect.gen(function* () {
        const out = yield* stream(["\n", "  <think>", "plan", "</think>", "answer"].map(native));
        expectSummary(out, { reasoning: "plan", text: "answer" });
      }),
    { tags },
  );

  test.effect(
    "an empty block emits no reasoning parts",
    () =>
      Effect.gen(function* () {
        const out = yield* stream(["<think>", "</think>", "\n\n", "answer"].map(native));
        expectSummary(out, {
          text: "answer",
          shape: ["text-start", "text-delta", "text-end", "finish"],
        });
      }),
    { tags },
  );

  test.effect(
    "tags split at every chunk boundary and per character",
    () =>
      Effect.gen(function* () {
        // Includes look-alikes inside reasoning (`</b>`, `</thin`) that must be
        // held back as possible tag prefixes and then released verbatim.
        const full = "\n<think>a </b> and </thin k</think>\n\nanswer";
        for (const chunks of chunkings(full)) {
          const out = yield* stream(chunks.map(native));
          expectSummary(out, { reasoning: "a </b> and </thin k", text: "answer" });
        }
      }),
    { tags },
  );

  test.effect(
    "split tags in the OpenAI `delta.content` shape",
    () =>
      Effect.gen(function* () {
        for (const chunks of chunkings("<think>plan</think>answer")) {
          const out = yield* stream(chunks.map((content) => openai({ content })));
          expectSummary(out, { reasoning: "plan", text: "answer" });
        }
      }),
    { tags },
  );

  test.effect(
    "text that only resembles an opening tag is emitted verbatim",
    () =>
      Effect.gen(function* () {
        for (const full of ["<b>bold</b>", "<thinking>no</thinking>", "<", "<thi"]) {
          for (const chunks of full.length > 1 ? chunkings(full) : [[full]]) {
            const out = yield* stream(chunks.map(native));
            expectSummary(out, { text: full });
          }
        }
      }),
    { tags },
  );

  test.effect(
    "tags after the answer has started stay text",
    () =>
      Effect.gen(function* () {
        const midProse = yield* stream(["Use ", "<think>", " tags", "</think>", "."].map(native));
        expectSummary(midProse, { text: "Use <think> tags</think>." });
        const afterBlock = yield* stream(
          ["<think>", "plan", "</think>", "x ", "</think>", " y"].map(native),
        );
        expectSummary(afterBlock, { reasoning: "plan", text: "x </think> y" });
      }),
    { tags },
  );

  test.effect(
    "a stream truncated inside reasoning keeps everything as reasoning",
    () =>
      Effect.gen(function* () {
        // `</thi` is held back as a possible tag and flushed on finalize.
        const out = yield* stream(["<think>", "still thinking", " </thi"].map(native));
        expectSummary(out, {
          reasoning: "still thinking </thi",
          shape: ["reasoning-start", "reasoning-delta", "reasoning-end", "finish"],
        });
      }),
    { tags },
  );

  test.effect(
    "whitespace-only output never opens a text block",
    () =>
      Effect.gen(function* () {
        const out = yield* stream(["\n", "  "].map(native));
        expectSummary(out, { shape: ["finish"] });
      }),
    { tags },
  );

  test.effect(
    "a prefilled-`<think>` model (qwq) starts inside reasoning",
    () =>
      Effect.gen(function* () {
        const chunks = ["Okay", ", pong.", "\n", "</think>", "\n\n", "Pong"].map(native);
        const qwq = yield* stream(chunks, { model: QWQ });
        expectSummary(qwq, { reasoning: "Okay, pong.\n", text: "Pong", shape: REASONED });
        // The same bytes from a model that opens its own tag are plain text:
        // a stream can't take back text it already emitted.
        const other = yield* stream(chunks);
        expectSummary(other, { text: "Okay, pong.\n</think>\n\nPong" });
      }),
    { tags },
  );

  test.effect(
    "a prefilled model truncated before `</think>` is all reasoning",
    () =>
      Effect.gen(function* () {
        const out = yield* stream(["Okay", ", so"].map(native), { model: QWQ });
        expectSummary(out, { reasoning: "Okay, so" });
      }),
    { tags },
  );

  test.effect(
    "with tools: a tool call after the block becomes a tool-call part",
    () =>
      Effect.gen(function* () {
        const out = yield* stream(
          [
            "<think>",
            "need weather",
            "</think>",
            "\n",
            '{"name":"get_weather",',
            '"parameters":{"city":"Paris"}}',
          ].map(native),
          { tools: true },
        );
        expect(out.reasoning).toBe("need weather");
        expect(out.text).toBe("");
        const call = out.parts.find((p) => p.type === "tool-call");
        expect(call).toMatchObject({ name: "get_weather", params: { city: "Paris" } });
        expect(out.parts.some((p) => p.type === "tool-result")).toBe(true);
      }),
    { tags },
  );

  test.effect(
    "with tools: prose after the block is emitted once",
    () =>
      Effect.gen(function* () {
        const out = yield* stream(["<think>", "no tool", "</think>", "\n\n", "Pong"].map(native), {
          tools: true,
        });
        expectSummary(out, { reasoning: "no tool", text: "Pong" });
        expect(out.parts.some((p) => p.type === "tool-call")).toBe(false);
      }),
    { tags },
  );
});

describe("streamText chunk-shape regressions", () => {
  test.effect(
    "text mirrored in `response` and `delta.content` is emitted once (#1907)",
    () =>
      Effect.gen(function* () {
        const mirrored = (t: string) => ({ ...openai({ content: t }), response: t });
        const out = yield* stream(["Hi", "!"].map(mirrored));
        expectSummary(out, { text: "Hi!" });
        const withTools = yield* stream(["Hi", "!"].map(mirrored), { tools: true });
        expectSummary(withTools, { text: "Hi!" });
      }),
    { tags },
  );

  test.effect(
    "mirrored reasoning fields with empty `tool_calls` form one reasoning block",
    () =>
      Effect.gen(function* () {
        const reasoning = (t: string) => openai({ reasoning: t, reasoning_content: t });
        const out = yield* stream([
          reasoning("a"),
          reasoning("b"),
          reasoning("c"),
          openai({ content: "answer" }),
        ]);
        expectSummary(out, { reasoning: "abc", text: "answer", shape: REASONED });
      }),
    { tags },
  );
});

describe("generateText <think> splitting", () => {
  test.effect(
    "a leading block is split from the answer",
    () =>
      Effect.gen(function* () {
        const out = yield* generate({ response: "\n<think>\nplan\n</think>\n\nanswer" });
        expect(out).toEqual({ reasoning: "\nplan\n", text: "answer" });
      }),
    { tags },
  );

  test.effect(
    "a bare `</think>` marks reasoning on any model",
    () =>
      Effect.gen(function* () {
        const out = yield* generate({ response: "plan\n</think>\n\nanswer" });
        expect(out).toEqual({ reasoning: "plan\n", text: "answer" });
      }),
    { tags },
  );

  test.effect(
    "an unclosed block (truncated) is all reasoning",
    () =>
      Effect.gen(function* () {
        expect(yield* generate({ response: "<think>still going" })).toEqual({
          reasoning: "still going",
          text: "",
        });
        expect(yield* generate({ response: "still going" }, QWQ)).toEqual({
          reasoning: "still going",
          text: "",
        });
      }),
    { tags },
  );

  test.effect(
    "text without a leading block is left untouched",
    () =>
      Effect.gen(function* () {
        // `<`/`<thi` are held back as possible tag prefixes and must come back.
        for (const response of [
          "answer",
          "<b>bold</b>",
          "Use <think> tags.",
          "<thinking>x",
          "<",
          "<thi",
          "  <thi",
        ]) {
          expect(yield* generate({ response })).toEqual({ reasoning: undefined, text: response });
        }
      }),
    { tags },
  );

  test.effect(
    "a separate reasoning field passes through with the answer",
    () =>
      Effect.gen(function* () {
        const out = yield* generate({
          choices: [
            { message: { content: "answer", reasoning_content: "plan" }, finish_reason: "stop" },
          ],
        });
        expect(out).toEqual({ reasoning: "plan", text: "answer" });
      }),
    { tags },
  );
});
