import { expect, it, vi } from "vite-plus/test";

it("meters microphone-only capture like transcription without emitting PCM", async () => {
  using globals = new DisposableStack();
  const setGlobal = (name: string, value: unknown) => {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    globals.defer(() => {
      if (original) Object.defineProperty(globalThis, name, original);
      else Reflect.deleteProperty(globalThis, name);
    });
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  };
  class Worklet {
    readonly port = {
      onmessage: null as ((event: { data: string }) => void) | null,
      postMessage: vi.fn<(data: unknown) => void>(),
    };
    process(_inputs: Float32Array[][]): boolean {
      return true;
    }
  }
  let Processor!: new (options?: { processorOptions: { meterOnly: boolean } }) => Worklet;
  setGlobal("sampleRate", 48_000);
  setGlobal("AudioWorkletProcessor", Worklet);
  setGlobal("registerProcessor", (_name: string, processor: typeof Processor) => {
    Processor = processor;
  });
  await import("./pcmWorklet");
  const transcription = new Processor();
  const microphone = new Processor({ processorOptions: { meterOnly: true } });
  transcription.port.onmessage?.({ data: "start" });
  microphone.port.onmessage?.({ data: "start" });
  const feed = (samples: Float32Array) => {
    transcription.process([[samples]]);
    microphone.process([[samples]]);
  };
  const levels = (processor: Worklet) =>
    processor.port.postMessage.mock.calls
      .map(([data]) => data)
      .filter((data) => typeof data === "number");

  feed(new Float32Array(2_399).fill(0.1));
  expect(levels(microphone)).toHaveLength(0);
  feed(new Float32Array(1).fill(0.1));
  expect(levels(microphone)).toHaveLength(1);
  feed(new Float32Array(48_000).fill(0.25));
  feed(new Float32Array(2_400));

  const measured = levels(microphone);
  expect(measured).toEqual(levels(transcription));
  expect(measured).toHaveLength(22);
  expect(measured[0]).toBeGreaterThan(0);
  expect(measured[0]).toBeLessThan(0.4);
  expect(measured.at(-1)).toBeGreaterThan(0);
  expect(measured.at(-1)).toBeLessThan(measured.at(-2)!);
  expect(
    transcription.port.postMessage.mock.calls.some(([data]) => data instanceof Float32Array),
  ).toBe(true);
  expect(microphone.port.postMessage.mock.calls.every(([data]) => typeof data === "number")).toBe(
    true,
  );
  microphone.port.onmessage?.({ data: "stop" });
  expect(microphone.port.postMessage).toHaveBeenLastCalledWith("stopped");
});
