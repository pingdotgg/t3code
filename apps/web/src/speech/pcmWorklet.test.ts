import { afterEach, expect, it, vi } from "vite-plus/test";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("mixes channels and publishes the final partial PCM block before acknowledging stop", async () => {
  const messages: (string | Float32Array)[] = [];
  const port = {
    onmessage: (_event: { data: string }) => {},
    postMessage: (value: string | Float32Array) => messages.push(value),
  };
  let create: (() => { process(inputs: Float32Array[][]): boolean }) | undefined;
  vi.stubGlobal("sampleRate", 48_000);
  vi.stubGlobal(
    "AudioWorkletProcessor",
    class {
      port = port;
    },
  );
  vi.stubGlobal(
    "registerProcessor",
    (_name: string, Processor: new () => { process(inputs: Float32Array[][]): boolean }) => {
      create = () => new Processor();
    },
  );
  await import("./pcmWorklet");
  const processor = create!();
  const left = new Float32Array(128).fill(0.25);
  const right = new Float32Array(128).fill(0.75);
  processor.process([[left, right]]);
  expect(messages).toHaveLength(0);
  port.onmessage({ data: "start" });
  for (let i = 0; i < 30; i++) processor.process([[left, right]]);
  expect(messages).toHaveLength(0);
  port.onmessage({ data: "stop" });
  expect(messages).toHaveLength(2);
  expect(messages[1]).toBe("stopped");
  const audio = messages[0] as Float32Array;
  expect(audio.length).toBe(Math.floor((30 * 128 + 62) / 3));
  expect(audio[100]).toBeCloseTo(0.5);
  processor.process([[left, right]]);
  expect(messages).toHaveLength(2);
});
