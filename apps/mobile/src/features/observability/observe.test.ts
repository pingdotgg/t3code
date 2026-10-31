import { expect, it, vi } from "vite-plus/test";

const observe = vi.hoisted(() => {
  Reflect.set(globalThis, "__DEV__", true);
  return { configure: vi.fn(), dispatchEvents: vi.fn(), reportError: vi.fn() };
});

vi.mock("expo-observe", () => ({ Observe: observe }));
vi.mock("expo-constants", () => ({
  default: { expoConfig: { extra: { relay: { url: "https://relay.example.test" } } } },
}));

import { crashReportingAvailable, setCrashReportsEnabled } from "./observe";

// [fork:lockdown] Tripwire: crash reports never dispatch, even from a build with a relay URL
// and a user who turns them on. AGENTS.md, invariant 1.
it("never turns crash report dispatching on", async () => {
  expect(crashReportingAvailable).toBe(false);
  await setCrashReportsEnabled(true);
  expect(observe.dispatchEvents).not.toHaveBeenCalled();
  for (const [options] of observe.configure.mock.calls) {
    expect(options).toMatchObject({ dispatchingEnabled: false });
  }
  expect(observe.configure).toHaveBeenCalled();
});
