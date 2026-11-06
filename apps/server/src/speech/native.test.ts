// @effect-diagnostics nodeBuiltinImport:off - verifies isolated native worker processes and their exit events.
import { expect, it } from "vite-plus/test";

import { loadNativeSpeechModel, preferCpuForSlowIntegratedGpu } from "./native.ts";

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

it("prefers CPU only when an integrated GPU misses real time by a clear margin", () => {
  expect(preferCpuForSlowIntegratedGpu(1800, 900, 1000)).toBe(true);
  expect(preferCpuForSlowIntegratedGpu(900, 400, 1000)).toBe(false);
  expect(preferCpuForSlowIntegratedGpu(1800, 1700, 1000)).toBe(false);
  expect(preferCpuForSlowIntegratedGpu(1800, 0, 1000)).toBe(false);
  expect(preferCpuForSlowIntegratedGpu(Number.NaN, 100, 1000)).toBe(false);
  expect(preferCpuForSlowIntegratedGpu(1800, undefined, 1000)).toBe(false);
});

const deviceProbeFixture = (gpuDelay: number, cpuDelay: number, deviceType = "igpu") =>
  `data:text/javascript,${encodeURIComponent(`
    const loads = [];
    const devices = [
      { deviceType: ${JSON.stringify(deviceType)}, kind: "vulkan", name: "UHD", deviceId: "gpu-1", index: 0 },
      { deviceType: "cpu", kind: "cpu", name: "CPU", deviceId: null, index: 1 },
    ];
    export const getAvailableBackends = () => devices;
    export const TranscribeModel = { load: async (_path, options) => {
      const which = options.device?.deviceType ?? (options.backend === "cpu" ? "cpu" : ${JSON.stringify(deviceType)});
      loads.push(which);
      const delay = which === "cpu" ? ${cpuDelay} : ${gpuDelay};
      return {
        device: devices.find((device) => device.deviceType === which) ?? devices[0],
        backend: loads.join(">"),
        capabilities: { supportsStreaming: true, supportsTranslate: false },
        supports: () => false,
        dispose() {},
        createSession: () => ({
          dispose() {},
          stream: async () => ({
            feed: () => new Promise((resolve) => setTimeout(resolve, delay)),
            finalize: async () => {},
            text: { full: "", committed: "", tentative: "" },
            reset() {},
          }),
        }),
      };
    } };
  `)}`;

it("keeps a realtime integrated GPU and a discrete GPU on the library choice", async () => {
  for (const deviceType of ["igpu", "gpu"]) {
    const model = await loadNativeSpeechModel(
      "unused.gguf",
      new AbortController().signal,
      deviceProbeFixture(0, 0, deviceType),
    );
    try {
      expect(model.backend).toBe(deviceType);
    } finally {
      await model.dispose();
    }
  }
});

it("moves Auto off an integrated GPU that cannot stream in real time when CPU is faster", async () => {
  const model = await loadNativeSpeechModel(
    "unused.gguf",
    new AbortController().signal,
    deviceProbeFixture(700, 20),
  );
  try {
    expect(model.backend).toBe("igpu>cpu");
  } finally {
    await model.dispose();
  }
});

it("restores the integrated GPU when CPU is not clearly faster", async () => {
  const model = await loadNativeSpeechModel(
    "unused.gguf",
    new AbortController().signal,
    deviceProbeFixture(700, 900),
  );
  try {
    expect(model.backend).toBe("igpu>cpu>igpu");
  } finally {
    await model.dispose();
  }
});

it("returns transcription from an isolated process and disposes it", async () => {
  const model = await loadNativeSpeechModel(
    "unused.gguf",
    new AbortController().signal,
    fixture("async (pcm) => ({ text: String(pcm[0]) })"),
  );
  try {
    expect(
      await model.transcribe(
        new Float32Array([0.25]),
        { timestamps: "none", language: "en" },
        false,
      ),
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
      const result = await model.transcribe(new Float32Array([0.25]), options, false);
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
      model.transcribe(new Float32Array([0.25]), { timestamps: "none", language: "en" }, false),
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
  const pending = model.transcribe(
    new Float32Array([0.25]),
    {
      timestamps: "none",
      language: "en",
    },
    false,
  );
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
    await model.begin({ timestamps: "none" }, false);
    expect(await model.feed(new Float32Array(512).fill(0.25))).toEqual({
      revision: 1,
      text: { committed: "hello ", tentative: "world" },
    });
    expect(await model.finish()).toBe("hello world");
    await model.begin({ timestamps: "none", language: "fr" }, false);
    await model.reset();
    await model.begin({ timestamps: "none", language: "fr" }, false);
    await model.feed(new Float32Array(512));
    expect(await model.finish()).toBe("fr");
    await model.begin(
      { timestamps: "none", language: "fr", vocabulary: ["T3 Code", "GitHub"] },
      false,
    );
    await model.feed(new Float32Array(512).fill(0.25));
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
  await model.begin({ timestamps: "none" }, false);
  const rejected = expect(model.feed(new Float32Array(512).fill(0.25))).rejects.toThrow();
  controller.abort();
  await model.dispose();
  await rejected;
});
const vadFixture = ({
  streaming = false,
  failVad = false,
  failVadLoad = false,
  failAsr = false,
  maxAudioMs = 4000,
} = {}) =>
  `data:text/javascript,${encodeURIComponent(`
    const summarize = pcm => String(pcm.length) + ":" + pcm[0].toFixed(2) + ":" + pcm[pcm.length - 1].toFixed(2);
    export const TranscribeModel = { load: async (path, options) => {
      if (path === "vad.gguf") {
        if (${failVadLoad}) throw new Error("VAD unavailable");
        if (options.backend !== "cpu") throw new Error("VAD must use CPU");
        return { vadInfo: { sampleRate: 16000, frameSamples: 512 }, dispose() {},
          createVadSession: ({ nThreads }) => {
            if (nThreads !== 1) throw new Error("VAD thread count");
            let pending = []; let at = 0;
            const score = final => {
              const firstFrame = at;
              const probs = [];
              while (pending.length >= 512 || final && pending.length) {
                probs.push(pending[0] > 0.5 ? 0.9 : 0);
                pending.splice(0, 512); at++;
              }
              return { firstFrame, probs };
            };
            return { dispose() {}, streamReset: async () => { pending = []; at = 0; },
              streamFeed: async pcm => {
                if (${failVad} && pcm[0] < 0) throw new Error("VAD fixture failed");
                pending.push(...pcm); return score(false);
              },
              streamFlush: async () => score(true),
            };
          },
        };
      }
      return { backend: "CPU", supports: () => false,
        capabilities: { supportsStreaming: ${streaming}, maxAudioMs: ${maxAudioMs} },
        transcribe: async pcm => { if (${failAsr}) throw new Error("ASR fixture failed"); return { text: summarize(pcm) }; },
        createSession: () => {
          let all = [];
          return { dispose() {}, stream: async () => ({
            feed: async pcm => { all.push(...pcm); return { committedChanged: true }; },
            finalize: async () => {}, reset() { all = []; },
            get text() { const full = summarize(all); return { committed: full, tentative: "", full }; },
          }) };
        },
      };
    }};
  `)}`;

it("filters silence and preserves partial speech through the production worker and resets between recordings", async () => {
  for (const streaming of [false, true]) {
    const model = await loadNativeSpeechModel(
      "asr.gguf",
      new AbortController().signal,
      vadFixture({ streaming }),
      "cpu",
    );
    try {
      expect(
        await model.transcribe(new Float32Array(2000), { timestamps: "none" }, true, "vad.gguf"),
      ).toEqual({ text: "" });
      expect(
        await model.transcribe(
          new Float32Array([0.8, 0.6]),
          { timestamps: "none" },
          true,
          "vad.gguf",
        ),
      ).toEqual({ text: "2:0.80:0.60" });
      expect(
        await model.transcribe(new Float32Array(2000), { timestamps: "none" }, false, "vad.gguf"),
      ).toEqual({ text: "2000:0.00:0.00" });
      for (const cancel of [true, false]) {
        await model.begin({ timestamps: "none" }, true, "vad.gguf");
        await model.feed(new Float32Array(600));
        expect(await model.finish()).toBe("");
        await model.begin({ timestamps: "none" }, true, "vad.gguf");
        await model.feed(new Float32Array(511).fill(0.8));
        if (cancel) await model.reset();
        else expect(await model.finish()).toBe("511:0.80:0.80");
      }
    } finally {
      await model.dispose();
    }
  }
});

it("decodes complete stable chunks before Stop and returns the ordered final tail", async () => {
  const model = await loadNativeSpeechModel(
    "asr.gguf",
    new AbortController().signal,
    vadFixture(),
    "cpu",
  );
  try {
    await model.begin({ timestamps: "none" }, false, "vad.gguf");
    await model.feed(new Float32Array(16000).fill(0.1));
    await model.feed(new Float32Array(16000).fill(0.2));
    const update = await model.feed(new Float32Array(16000).fill(0.3));
    expect(update.text).toEqual({ committed: "32000:0.10:0.20", tentative: "" });
    await model.feed(new Float32Array([0.4, 0.5]));
    expect(await model.finish()).toBe("32000:0.10:0.20 16002:0.30:0.50");
  } finally {
    await model.dispose();
  }
});

it("preserves withheld audio on VAD failure while keeping ASR failures distinct", async () => {
  for (const streaming of [false, true]) {
    const model = await loadNativeSpeechModel(
      "asr.gguf",
      new AbortController().signal,
      vadFixture({ streaming, failVad: true }),
      "cpu",
    );
    try {
      await model.begin({ timestamps: "none" }, true, "vad.gguf");
      await model.feed(new Float32Array(512).fill(0.1));
      await model.feed(new Float32Array(512).fill(-0.2));
      expect(await model.finish()).toBe("1024:0.10:-0.20");
      await model.begin({ timestamps: "none" }, true, "vad.gguf");
      await model.feed(new Float32Array(512));
      expect(await model.finish()).toBe("");
    } finally {
      await model.dispose();
    }
  }
  const unavailable = await loadNativeSpeechModel(
    "asr.gguf",
    new AbortController().signal,
    vadFixture({ failVadLoad: true }),
    "cpu",
  );
  try {
    expect(
      await unavailable.transcribe(
        new Float32Array(2000).fill(0.1),
        { timestamps: "none" },
        true,
        "vad.gguf",
      ),
    ).toEqual({ text: "2000:0.10:0.10" });
  } finally {
    await unavailable.dispose();
  }
  const model = await loadNativeSpeechModel(
    "asr.gguf",
    new AbortController().signal,
    vadFixture({ failAsr: true }),
    "cpu",
  );
  try {
    await expect(
      model.transcribe(new Float32Array(512).fill(0.8), { timestamps: "none" }, true, "vad.gguf"),
    ).rejects.toThrow("ASR fixture failed");
  } finally {
    await model.dispose();
  }
});
