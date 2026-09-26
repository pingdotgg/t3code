import * as NodeModule from "node:module";
import { expect, it } from "vite-plus/test";
import { listNativeSpeechGpuDevices, loadNativeSpeechModel } from "./native.ts";

it("ignores unrelated device probe messages and returns GPU devices", async () => {
  const moduleUrl = `data:text/javascript,${encodeURIComponent(`
    process.send?.({ type: "unrelated-control-message" });
    export const getAvailableBackends = () => [
      { kind: "vulkan", deviceType: "gpu", deviceId: "gpu-1", name: "GPU", description: "Test GPU" },
      { kind: "cpu", deviceType: "cpu", deviceId: null, name: "CPU", description: "CPU" },
    ];
  `)}`;
  await expect(listNativeSpeechGpuDevices(moduleUrl)).resolves.toEqual([
    { id: '["vulkan","gpu-1"]', name: "Test GPU" },
  ]);
});

const fixture = (transcribe: string) =>
  `data:text/javascript,${encodeURIComponent(`export const TranscribeModel = { load: async () => ({ capabilities: { supportsStreaming: false }, supports: () => false, transcribe: ${transcribe} }) };`)}`;

it("raises the speech worker's Koffi stack before loading the binding", async () => {
  const koffiPath = NodeModule.createRequire(import.meta.resolve("transcribe-cpp")).resolve(
    "koffi",
  );
  const moduleUrl = `data:text/javascript,${encodeURIComponent(`
    import { createRequire } from "node:module";
    const koffi = createRequire(${JSON.stringify(koffiPath)})(${JSON.stringify(koffiPath)});
    export const TranscribeModel = { load: async () => ({
      backend: String(koffi.config().async_stack_size),
      capabilities: { supportsStreaming: false },
      supports: () => false,
    }) };
  `)}`;
  const model = await loadNativeSpeechModel("unused.gguf", new AbortController().signal, moduleUrl);
  try {
    expect(Number(model.backend)).toBeGreaterThanOrEqual(2 * 1024 * 1024);
  } finally {
    await model.dispose();
  }
});

const fixtureWithUnrelatedIpcMessage = () =>
  `data:text/javascript,${encodeURIComponent(`
    process.send?.({ type: "unrelated-control-message" });
    export const TranscribeModel = {
      load: async () => ({ capabilities: { supportsStreaming: false }, supports: () => false, transcribe: async () => ({ text: "hello" }) }),
    };
  `)}`;

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
}, 5000);

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

const streamingFixture = (feed: string) =>
  `data:text/javascript,${encodeURIComponent(`
  export const TranscribeModel = { load: async () => ({
    capabilities: { supportsStreaming: true },
    supports: () => false,
    createSession: () => ({
      dispose() {},
      stream: async (opts) => ({
        feed: ${feed},
        finalize: async () => {},
        text: { full: opts.language ?? "hello world", committed: "hello ", tentative: "world" },
        reset() {},
      }),
    }),
  }) };
`)}`;

it("returns streaming previews and final text from an isolated process", async () => {
  const model = await loadNativeSpeechModel(
    "unused.gguf",
    new AbortController().signal,
    streamingFixture(
      "async () => ({ revision: 1, committedChanged: true, tentativeChanged: true })",
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
  } finally {
    await model.dispose();
  }
});

it("waits for an active feed before resetting the stream", async () => {
  const model = await loadNativeSpeechModel(
    "unused.gguf",
    new AbortController().signal,
    streamingFixture(
      "async () => { await new Promise((resolve) => setImmediate(resolve)); return { revision: 1, committedChanged: true, tentativeChanged: true }; }",
    ),
  );
  try {
    await model.begin();
    const feeding = model.feed(new Float32Array([0.25]));
    const resetting = model.reset();
    await feeding;
    await resetting;
    await model.begin();
    expect(await model.finish()).toBe("hello world");
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
}, 5000);
