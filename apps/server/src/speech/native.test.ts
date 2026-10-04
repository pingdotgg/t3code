// @effect-diagnostics nodeBuiltinImport:off - verifies isolated native worker processes and their exit events.
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import { expect, it, vi } from "vite-plus/test";
import * as NodeChildProcess from "node:child_process";
import { listNativeSpeechGpuDevices, loadNativeSpeechModel } from "./native.ts";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeChildProcess>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

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

const fixture = (transcribe: string, maxAudioMs = 0) =>
  `data:text/javascript,${encodeURIComponent(`export const TranscribeModel = { load: async () => ({ capabilities: { supportsStreaming: false, maxAudioMs: ${maxAudioMs} }, supports: () => false, transcribe: ${transcribe} }) };`)}`;

it("transcribes a five-minute clip in bounded pieces without dropping samples", async () => {
  const model = await loadNativeSpeechModel(
    "unused.gguf",
    new AbortController().signal,
    fixture(
      `async (pcm) => {
      if (pcm.length > 388000) throw new Error("oversized call");
      return { text: String(pcm.reduce((sum, sample) => sum + sample, 0)) };
    }`,
      48500,
    ),
  );
  try {
    const pcm = new Float32Array(16000 * 300).fill(1);
    const result = await model.transcribe(pcm, { timestamps: "none" });
    expect(
      result.text
        .split(" ")
        .map(Number)
        .reduce((sum, value) => sum + value, 0),
    ).toBe(pcm.length);
    expect(result.text.split(" ").length).toBeGreaterThan(1);
  } finally {
    await model.dispose();
  }
});

it.each(["OutputTruncated", "InputTooLong"])(
  "retries %s pieces instead of returning partial text",
  async (name) => {
    const model = await loadNativeSpeechModel(
      "unused.gguf",
      new AbortController().signal,
      fixture(`async (pcm) => {
      if (pcm.length > 4000) {
        const error = new (class ${name} extends Error {})();
        error.partialResult = { text: "incomplete" };
        throw error;
      }
      return { text: String(pcm.length) };
    }`),
    );
    try {
      expect(await model.transcribe(new Float32Array(16000), { timestamps: "none" })).toEqual({
        text: "4000 4000 4000 4000",
      });
    } finally {
      await model.dispose();
    }
  },
);

it("uses the binding's Vulkan-safe Koffi stack in the speech worker", async () => {
  const koffiPath = NodeModule.createRequire(import.meta.resolve("transcribe-cpp")).resolve(
    "koffi",
  );
  const moduleUrl = `data:text/javascript,${encodeURIComponent(`
    await import(${JSON.stringify(import.meta.resolve("transcribe-cpp"))});
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

it("passes translation options to the native model", async () => {
  const model = await loadNativeSpeechModel(
    "unused.gguf",
    new AbortController().signal,
    fixture("async (_pcm, options) => ({ text: JSON.stringify(options) })"),
  );
  try {
    const result = await model.transcribe(new Float32Array([0.25]), {
      timestamps: "none",
      language: "es",
      task: "translate",
      targetLanguage: "en",
    });
    expect(JSON.parse(result.text)).toEqual({
      timestamps: "none",
      language: "es",
      task: "translate",
      targetLanguage: "en",
    });
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

it("terminates a GPU probe after returning its devices", async () => {
  const { spawn } = await vi.importActual<typeof NodeChildProcess>("node:child_process");
  let exited: Promise<void> | undefined;
  const probe = vi.spyOn(NodeChildProcess, "spawn").mockImplementation((...args) => {
    const child = spawn(...args);
    exited = new Promise((resolve) => child.once("exit", () => resolve()));
    return child;
  });
  try {
    const moduleUrl = `data:text/javascript,${encodeURIComponent("export const getAvailableBackends = () => [];")}`;
    await expect(listNativeSpeechGpuDevices(moduleUrl)).resolves.toEqual([]);
    await exited;
  } finally {
    probe.mockRestore();
  }
});

it("times out and terminates a GPU probe that never replies", async () => {
  const { spawn } = await vi.importActual<typeof NodeChildProcess>("node:child_process");
  let exited: Promise<void> | undefined;
  const probe = vi.spyOn(NodeChildProcess, "spawn").mockImplementation((...args) => {
    const child = spawn(...args);
    exited = new Promise((resolve) => child.once("exit", () => resolve()));
    return child;
  });
  vi.useFakeTimers();
  try {
    const moduleUrl = `data:text/javascript,${encodeURIComponent("await new Promise(() => {}); export const getAvailableBackends = () => [];")}`;
    const rejected = expect(listNativeSpeechGpuDevices(moduleUrl)).rejects.toThrow(
      "Speech device discovery timed out.",
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    await exited;
  } finally {
    vi.useRealTimers();
    probe.mockRestore();
  }
});

it.each(["t three code", "t 3 code"])(
  "matches %s across committed increments and resets dictionaries",
  async (phrase) => {
    const model = await loadNativeSpeechModel(
      "unused.gguf",
      new AbortController().signal,
      streamingFixture(`async function (pcm) {
      this.text.committed = pcm[0] === 1 ? "open t " : "open ${phrase}";
      this.text.tentative = "";
      this.text.full = this.text.committed;
      return { revision: pcm[0], committedChanged: true };
    }`),
    );
    try {
      await model.begin(undefined, ["T3 Code"], [{ term: "T3 Code", aliases: ["t three code"] }]);
      await model.feed(new Float32Array([1]));
      expect((await model.feed(new Float32Array([2]))).text?.committed).toBe("open T3 Code");
      expect(await model.finish()).toBe("open T3 Code");
      await model.begin();
      expect((await model.feed(new Float32Array([2]))).text?.committed).toBe(`open ${phrase}`);
      await model.reset();
      await model.begin("er", ["err"]);
      // Also exercise fuzzy correction rather than only exact aliases.
      expect(await model.finish()).toBe("err");
    } finally {
      await model.dispose();
    }
  },
);

it("serves HTTP requests while the child corrects a large streaming transcript", async () => {
  const server = NodeHttp.createServer((_request, response) => response.end("responsive"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server port");
  const model = await loadNativeSpeechModel(
    "unused.gguf",
    new AbortController().signal,
    streamingFixture(`async function () {
      this.text.committed = "dictionary ".repeat(1200);
      process.send({ type: "correction-starting" });
      return { revision: 1, committedChanged: true };
    }`),
  );
  try {
    const child = vi.mocked(NodeChildProcess.spawn).mock.results.at(-1)?.value;
    if (!child) throw new Error("Missing inference child");
    const started = new Promise<void>((resolve) =>
      child.on("message", (message: unknown) => {
        if (
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "correction-starting"
        )
          resolve();
      }),
    );
    await model.begin(
      undefined,
      Array.from({ length: 100 }, (_, index) => `dictionary${index}`),
    );
    let finished = false;
    const feeding = model.feed(new Float32Array([1])).then((result) => {
      finished = true;
      return result;
    });
    await started;
    const response = await new Promise<string>((resolve, reject) => {
      NodeHttp.get(`http://127.0.0.1:${address.port}`, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => resolve(body));
        response.on("error", reject);
      }).on("error", reject);
    });
    expect(response).toBe("responsive");
    expect(finished).toBe(false);
    expect((await feeding).text?.committed).toContain("dictionary");
  } finally {
    await model.dispose();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}, 10000);
