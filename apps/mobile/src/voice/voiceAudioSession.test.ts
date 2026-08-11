import { describe, expect, it, vi } from "vite-plus/test";

const expoMocks = vi.hoisted(() => ({ requireOptionalNativeModule: vi.fn(() => null) }));

vi.mock("expo", () => ({
  requireOptionalNativeModule: expoMocks.requireOptionalNativeModule,
}));

import { createNativeVoiceAudioSession } from "./voiceAudioSession";

function nativeModuleHarness(startImplementation?: () => number) {
  const nativeListeners = new Set<(event: unknown) => void>();
  const remove = vi.fn();
  let nextActivationToken = 0;
  const module = {
    start: vi.fn(startImplementation ?? (() => ++nextActivationToken)),
    stop: vi.fn((_activationToken: number) => undefined),
    addListener: vi.fn(
      (_eventName: "onVoiceAudioSessionEvent", listener: (event: unknown) => void) => {
        nativeListeners.add(listener);
        return {
          remove: () => {
            nativeListeners.delete(listener);
            remove();
          },
        };
      },
    ),
  };
  return {
    module,
    remove,
    emit(event: unknown) {
      for (const listener of nativeListeners) listener(event);
    },
  };
}

describe("native voice audio-session adapter", () => {
  it("acquires and releases one token-scoped native lease", () => {
    const native = nativeModuleHarness();
    const resolveModule = vi.fn(() => native.module);
    const session = createNativeVoiceAudioSession(resolveModule);
    const listener = vi.fn();
    const lease = session.start(listener);

    native.emit({ kind: "interruption", activationToken: 1 });
    native.emit({ kind: "route_lost", activationToken: 1 });
    native.emit({ kind: "media_services_reset", activationToken: 1 });
    lease.stop();
    lease.stop();

    expect(native.module.addListener).toHaveBeenCalledWith(
      "onVoiceAudioSessionEvent",
      expect.any(Function),
    );
    expect(native.module.start).toHaveBeenCalledOnce();
    expect(native.module.stop).toHaveBeenCalledOnce();
    expect(native.module.stop).toHaveBeenCalledWith(1);
    expect(listener.mock.calls.map(([event]) => event)).toEqual([
      "interruption",
      "route_lost",
      "media_services_reset",
    ]);
    expect(native.remove).toHaveBeenCalledOnce();
  });

  it("ignores malformed, inherited, accessor, unknown, and wrong-token payloads", () => {
    const native = nativeModuleHarness();
    const session = createNativeVoiceAudioSession(() => native.module);
    const listener = vi.fn();
    const lease = session.start(listener);
    const inherited = Object.create({ kind: "interruption", activationToken: 1 });
    const accessor = {};
    Object.defineProperties(accessor, {
      kind: { enumerable: true, get: () => "route_lost" },
      activationToken: { enumerable: true, value: 1 },
    });

    for (const value of [
      null,
      [],
      "interruption",
      {},
      inherited,
      accessor,
      { kind: "future_event", activationToken: 1 },
      { kind: "interruption" },
      { kind: "interruption", activationToken: 0 },
      { kind: "interruption", activationToken: 2 },
      { kind: "interruption", activationToken: 2_147_483_648 },
    ]) {
      native.emit(value);
    }

    expect(listener).not.toHaveBeenCalled();
    lease.stop();
  });

  it("filters a queued old-token event after a successor lease starts", () => {
    const native = nativeModuleHarness();
    const session = createNativeVoiceAudioSession(() => native.module);
    const firstListener = vi.fn();
    const first = session.start(firstListener);
    first.stop();
    const secondListener = vi.fn();
    const second = session.start(secondListener);

    native.emit({ kind: "interruption", activationToken: 1 });
    native.emit({ kind: "interruption", activationToken: 2 });

    expect(firstListener).not.toHaveBeenCalled();
    expect(secondListener).toHaveBeenCalledOnce();
    expect(native.module.stop).toHaveBeenNthCalledWith(1, 1);
    second.stop();
    expect(native.module.stop).toHaveBeenNthCalledWith(2, 2);
  });

  it("fails closed and removes the listener when the native module is unavailable or invalid", () => {
    const unavailable = createNativeVoiceAudioSession(() => null);
    expect(() => unavailable.start(vi.fn())).toThrow(
      "Voice audio session native module unavailable.",
    );

    const native = nativeModuleHarness(() => 0);
    const invalid = createNativeVoiceAudioSession(() => native.module);
    expect(() => invalid.start(vi.fn())).toThrow(
      "Voice audio session returned an invalid activation token.",
    );
    expect(native.remove).toHaveBeenCalledOnce();
    expect(native.module.stop).toHaveBeenCalledWith(0);
  });

  it("removes the listener when native acquisition throws", () => {
    const native = nativeModuleHarness(() => {
      throw new Error("native audio failure");
    });
    const session = createNativeVoiceAudioSession(() => native.module);

    expect(() => session.start(vi.fn())).toThrow("native audio failure");
    expect(native.remove).toHaveBeenCalledOnce();
    expect(native.module.stop).not.toHaveBeenCalled();
  });
});
