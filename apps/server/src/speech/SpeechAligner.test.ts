import { it } from "@effect/vitest";
import { describe, expect, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as LocalSpeechSynthesis from "./LocalSpeechSynthesis.ts";
import * as SpeechAligner from "./SpeechAligner.ts";

const RATE = 24_000;
const ENCODER_DELAY = 1105 / RATE;
const silence = (seconds: number) => new Int16Array(Math.round(seconds * RATE));

const setup = (options: {
  readonly installed: boolean;
  readonly aligned?: ReadonlyArray<ReadonlyArray<readonly [string, number, number]> | Error>;
}) => {
  const responses = [...(options.aligned ?? [])];
  const align = vi.fn(
    (_request: Parameters<LocalSpeechSynthesis.LocalSpeechSynthesis["Service"]["align"]>[0]) =>
      Effect.suspend(() => {
        const response = responses.shift() ?? [];
        if (response instanceof Error) return Effect.die(response);
        return Effect.succeed(
          response.map(([word, startSeconds, endSeconds]) => ({ word, startSeconds, endSeconds })),
        );
      }),
  );
  const layer = SpeechAligner.layer.pipe(
    Layer.provide(
      Layer.mock(LocalSpeechSynthesis.LocalSpeechSynthesis)({
        wordTiming: Effect.succeed({
          state: options.installed ? "installed" : "downloadable",
          size: 205_171_744,
        }),
        align,
      }),
    ),
  );
  return { align, layer };
};

const spoken = (text: string, words: ReadonlyArray<{ start: number; end: number }>) =>
  words.map((word) => text.slice(word.start, word.end));

describe("alignerSpelling", () => {
  it("spells words in the aligner's ASCII alphabet", () => {
    expect(SpeechAligner.alignerSpelling("Café,")).toBe("cafe");
    expect(SpeechAligner.alignerSpelling("Straße")).toBe("strasse");
    expect(SpeechAligner.alignerSpelling("don't")).toBe("don't");
    expect(SpeechAligner.alignerSpelling("ThreadList.tsx")).toBe("threadlisttsx");
    expect(SpeechAligner.alignerSpelling("25")).toBe("");
    expect(SpeechAligner.alignerSpelling("設定")).toBeUndefined();
    expect(SpeechAligner.alignerSpelling("привет")).toBeUndefined();
  });
});

it.effect("aligns each stretch once its audio is complete and spreads what it cannot spell", () => {
  const fake = setup({
    installed: true,
    aligned: [
      [
        ["alpha", 0.3, 0.6],
        ["beta", 0.7, 1],
        ["gamma", 1.6, 2],
      ],
      [["delta", 0.9, 1.3]],
    ],
  });
  return Effect.gen(function* () {
    const aligner = yield* SpeechAligner.SpeechAligner;
    const text = "Alpha beta 25 gamma.\n設定 delta.";
    const session = (yield* aligner.session(text, "en-US"))!;
    const first = { start: 0, end: 20 };
    const second = { start: 21, end: 30 };
    expect(
      yield* session.push({ pcm: silence(1), rate: RATE, startSeconds: 0, span: first }),
    ).toEqual([]);
    expect(
      yield* session.push({ pcm: silence(1.5), rate: RATE, startSeconds: 1, span: first }),
    ).toEqual([]);
    // The second stretch's audio arriving completes the first.
    const words = yield* session.push({
      pcm: silence(2),
      rate: RATE,
      startSeconds: 3,
      span: second,
    });
    expect(fake.align).toHaveBeenCalledTimes(1);
    const request = fake.align.mock.calls[0]![0];
    expect(request.text).toBe("alpha beta gamma");
    expect(request.language).toBe("en");
    expect(request.options).toEqual({
      text_normalization: "pre_romanized",
      star_frequency: "segment",
    });
    expect(request.audio.samples.length).toBe(2.5 * RATE);
    expect(spoken(text, words)).toEqual(["Alpha", "beta", "25", "gamma."]);
    expect(words[0]!.startSeconds).toBeCloseTo(ENCODER_DELAY + 0.3, 6);
    expect(words[3]!.startSeconds).toBeCloseTo(ENCODER_DELAY + 1.6, 6);
    // "25" carries no letters to align, so it fills the gap between its neighbors.
    expect(words[2]!.startSeconds).toBeCloseTo(ENCODER_DELAY + 1, 6);
    expect(words[2]!.endSeconds).toBeCloseTo(ENCODER_DELAY + 1.6, 6);

    const rest = yield* session.finish;
    expect(fake.align.mock.calls[1]![0].text).toBe("delta");
    expect(spoken(text, rest)).toEqual(["設定", "delta."]);
    expect(rest[0]!.startSeconds).toBeCloseTo(3 + ENCODER_DELAY, 6);
    expect(rest[1]!.startSeconds).toBeCloseTo(3 + ENCODER_DELAY + 0.9, 6);
  }).pipe(Effect.provide(fake.layer));
});

it.effect("estimates a stretch's words when alignment fails", () => {
  const fake = setup({
    installed: true,
    aligned: [new Error("worker exited"), [["beta", 0.2, 0.5]]],
  });
  return Effect.gen(function* () {
    const aligner = yield* SpeechAligner.SpeechAligner;
    const text = "Alpha.\nBeta.";
    const session = (yield* aligner.session(text, "auto"))!;
    yield* session.push({
      pcm: silence(2),
      rate: RATE,
      startSeconds: 0,
      span: { start: 0, end: 6 },
    });
    const estimated = yield* session.push({
      pcm: silence(1),
      rate: RATE,
      startSeconds: 2,
      span: { start: 7, end: 12 },
    });
    expect(spoken(text, estimated)).toEqual(["Alpha."]);
    expect(estimated[0]!.startSeconds).toBeCloseTo(ENCODER_DELAY, 6);
    expect(estimated[0]!.endSeconds).toBeCloseTo(ENCODER_DELAY + 2, 6);
    const timed = yield* session.finish;
    expect(timed[0]!.startSeconds).toBeCloseTo(2 + ENCODER_DELAY + 0.2, 6);
  }).pipe(Effect.provide(fake.layer));
});

it.effect("has no session until the word timing model is installed", () => {
  const fake = setup({ installed: false });
  return Effect.gen(function* () {
    const aligner = yield* SpeechAligner.SpeechAligner;
    expect(yield* aligner.session("Alpha beta.", "en")).toBeUndefined();
    expect(fake.align).not.toHaveBeenCalled();
  }).pipe(Effect.provide(fake.layer));
});
