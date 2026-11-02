import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  checkAvailability: vi.fn<() => Promise<boolean>>(),
}));

vi.mock("expo", () => ({
  requireOptionalNativeModule: () => ({ isAvailable: () => true, ...mocks }),
}));

import { getLocalVoiceTranscriber } from "./voiceTranscription.android";

it.each([false, true])(
  "waits for device support before offering a transcriber (%s)",
  async (supported) => {
    vi.resetAllMocks();
    const probe = Promise.withResolvers<boolean>();
    mocks.checkAvailability.mockReturnValue(probe.promise);
    let settled = false;
    const result = Promise.resolve(getLocalVoiceTranscriber()).then((transcriber) => {
      settled = true;
      return transcriber;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    probe.resolve(supported);
    expect((await result) !== null).toBe(supported);
  },
);
