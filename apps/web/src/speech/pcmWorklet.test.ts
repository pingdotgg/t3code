import { afterEach, expect, it, vi } from "vite-plus/test";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("mixes channels and publishes the final partial PCM block before acknowledging stop", async () => {
  const messages: (string | number | Float32Array)[] = [];
  const port = {
    onmessage: (_event: { data: string }) => {},
    postMessage: (value: string | number | Float32Array) => messages.push(value),
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
  for (let i = 0; i < 18; i++) processor.process([[left, right]]);
  expect(messages).toHaveLength(0);
  for (let i = 0; i < 12; i++) processor.process([[left, right]]);
  // A level arrives after 50 ms, before any 500 ms PCM chunk is ready.
  expect(messages).toHaveLength(1);
  expect(messages[0]).toBeCloseTo(1 - Math.exp(-0.05 / 0.075));
  port.onmessage({ data: "stop" });
  expect(messages).toHaveLength(3);
  expect(messages[2]).toBe("stopped");
  const audio = messages[1] as Float32Array;
  expect(audio.length).toBe(Math.floor((30 * 128 + 62) / 3));
  expect(audio[100]).toBeCloseTo(0.5);
  processor.process([[left, right]]);
  expect(messages).toHaveLength(3);
});

it("softens peaks, reaches sustained levels, and releases more slowly than it rises", async () => {
  const levels: number[] = [];
  const port = {
    onmessage: (_event: { data: string }) => {},
    postMessage: (value: unknown) => {
      if (typeof value === "number") levels.push(value);
    },
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
  port.onmessage({ data: "start" });
  const loud = new Float32Array(2_400).fill(0.25);
  processor.process([[loud]]);
  expect(levels[0]).toBeCloseTo(1 - Math.exp(-0.05 / 0.075));
  for (let i = 0; i < 19; i++) processor.process([[loud]]);
  const sustained = levels.at(-1)!;
  expect(sustained).toBeCloseTo(1, 4);
  processor.process([[new Float32Array(2_400)]]);
  expect(levels.at(-1)).toBeCloseTo(sustained * Math.exp(-0.05 / 0.2));
  for (let i = 0; i < 39; i++) processor.process([[new Float32Array(2_400)]]);
  expect(levels.at(-1)).toBeLessThan(0.0001);
});
