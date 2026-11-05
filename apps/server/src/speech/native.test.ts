// @effect-diagnostics nodeBuiltinImport:off - verifies isolated native worker processes and their exit events.
import { expect, it } from "vite-plus/test";

import { loadNativeSpeechModel } from "./native.ts";

const fixture = (transcribe: string, maxAudioMs = 0, supportsVocabulary = false) =>
  `data:text/javascript,${encodeURIComponent(`export const TranscribeModel = { load: async () => ({ capabilities: { supportsStreaming: false, maxAudioMs: ${maxAudioMs} }, supports: (feature) => feature === "vocabulary" && ${supportsVocabulary}, transcribe: ${transcribe} }) };`)}`;

const fixtureWithUnrelatedIpcMessage = () =>
  `data:text/javascript,${encodeURIComponent(`
    process.send?.({ type: "unrelated-control-message" });
    export const TranscribeModel = {
      load: async () => ({ capabilities: { supportsStreaming: false }, supports: () => false, transcribe: async () => ({ text: "hello" }) }),
    };
  `)}`;

const streamingFixture = (feed: string, supportsVocabulary = false) =>
  `data:text/javascript,${encodeURIComponent(`
  export const TranscribeModel = { load: async () => ({
    capabilities: { supportsStreaming: true },
    supports: (feature) => feature === "vocabulary" && ${supportsVocabulary},
    createSession: () => ({
      dispose() {},
      stream: async (opts) => ({
        feed: ${feed},
        finalize: async () => {},
        text: { full: opts.vocabulary?.join(" / ") ?? opts.language ?? "hello world", committed: "hello ", tentative: "world" },
        reset() {},
      }),
    }),
  }) };
`)}`;

it("returns transcription from an isolated process and disposes it", async () => {
  const model = await loadNativeSpeechModel(
    "unused.gguf",
    new AbortController().signal,
    fixture("async (pcm) => ({ text: String(pcm[0]) })"),
  );
  try {
    expect(
      await model.transcribe(new Float32Array([0.25]), { timestamps: "none", language: "en" }),
    ).toEqual({ text: "0.25" });
  } finally {
    await model.dispose();
  }
});

it("probes generic vocabulary support and delivers ordered terms to offline inference", async () => {
  for (const supported of [false, true]) {
    const model = await loadNativeSpeechModel(
      "unused.gguf",
      new AbortController().signal,
      fixture("async (_pcm, options) => ({ text: JSON.stringify(options) })", 0, supported),
    );
    try {
      expect(model.supportsVocabulary).toBe(supported);
      const options = {
        timestamps: "none" as const,
        language: "en",
        ...(supported ? { vocabulary: ["T3 Code", "GitHub"] } : {}),
      };
      const result = await model.transcribe(new Float32Array([0.25]), options);
      expect(JSON.parse(result.text)).toEqual(options);
    } finally {
      await model.dispose();
    }
  }
});

it("ignores IPC messages that do not belong to the speech protocol", async () => {
  const model = await loadNativeSpeechModel(
    "unused.gguf",
    new AbortController().signal,
    fixtureWithUnrelatedIpcMessage(),
  );
  try {
    await expect(
      model.transcribe(new Float32Array([0.25]), { timestamps: "none", language: "en" }),
    ).resolves.toEqual({ text: "hello" });
  } finally {
    await model.dispose();
  }
});

it("terminates hung native inference when the service shuts down", async () => {
  const controller = new AbortController();
  const model = await loadNativeSpeechModel(
    "unused.gguf",
    controller.signal,
    fixture("async () => { while (true) {} }"),
  );
  const pending = model.transcribe(new Float32Array([0.25]), {
    timestamps: "none",
    language: "en",
  });
  const rejected = expect(pending).rejects.toThrow();
  controller.abort();
  await model.dispose();
  await rejected;
});

it("returns streaming previews and final text from an isolated process", async () => {
  const model = await loadNativeSpeechModel(
    "unused.gguf",
    new AbortController().signal,
    streamingFixture(
      "async () => ({ revision: 1, committedChanged: true, tentativeChanged: true })",
      true,
    ),
  );
  try {
    expect(model.supportsStreaming).toBe(true);
    await model.begin();
    expect(await model.feed(new Float32Array([0.25]))).toEqual({
      revision: 1,
      text: { committed: "hello ", tentative: "world" },
    });
    expect(await model.finish()).toBe("hello world");
    await model.begin("fr");
    await model.reset();
    await model.begin("fr");
    expect(await model.finish()).toBe("fr");
    await model.begin("fr", ["T3 Code", "GitHub"]);
    expect(await model.finish()).toBe("T3 Code / GitHub");
  } finally {
    await model.dispose();
  }
});

it("kills a hung streaming feed without waiting for native cleanup", async () => {
  const controller = new AbortController();
  const model = await loadNativeSpeechModel(
    "unused.gguf",
    controller.signal,
    streamingFixture("async () => { while (true) {} }"),
  );
  await model.begin();
  const rejected = expect(model.feed(new Float32Array([0.25]))).rejects.toThrow();
  controller.abort();
  await model.dispose();
  await rejected;
});
