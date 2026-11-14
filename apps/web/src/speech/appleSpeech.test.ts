import { expect, it, vi } from "vite-plus/test";

it("probes Apple Speech again for a subscriber after a 'not available' answer", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  const isAvailable = vi
    .fn<() => Promise<boolean>>()
    .mockResolvedValueOnce(false)
    .mockResolvedValue(true);
  Object.defineProperty(globalThis, "window", {
    value: { desktopBridge: { appleSpeech: { isAvailable } } },
    configurable: true,
  });
  vi.useFakeTimers();
  let unsubscribe = () => {};
  try {
    const { appleSpeechAvailability } = await import("./appleSpeech");
    const notify = vi.fn();
    unsubscribe = appleSpeechAvailability.subscribe(notify);

    await vi.advanceTimersByTimeAsync(0);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(appleSpeechAvailability.getSnapshot()).toBe(false);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(isAvailable).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(appleSpeechAvailability.getSnapshot()).toBe(true);
  } finally {
    unsubscribe();
    vi.useRealTimers();
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
