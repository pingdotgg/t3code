import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  appState: "background",
  listeners: [] as Array<(state: string) => void>,
  isProtectedDataAvailable: vi.fn<() => Promise<boolean>>(),
}));

vi.mock("expo", () => ({
  requireOptionalNativeModule: () => ({ isProtectedDataAvailable: mocks.isProtectedDataAvailable }),
}));
vi.mock("react-native", () => ({
  AppState: {
    get currentState() {
      return mocks.appState;
    },
    addEventListener: (_event: string, listener: (state: string) => void) => {
      mocks.listeners.push(listener);
      return { remove: () => mocks.listeners.splice(mocks.listeners.indexOf(listener), 1) };
    },
  },
}));

let protectedData: typeof import("./protectedData");

beforeEach(async () => {
  vi.resetModules();
  mocks.appState = "background";
  mocks.listeners.length = 0;
  mocks.isProtectedDataAvailable.mockReset();
  protectedData = await import("./protectedData");
});

describe("whenProtectedDataAvailable", () => {
  it("waits for the foreground after a background launch on a locked device", async () => {
    const check = Promise.withResolvers<boolean>();
    mocks.isProtectedDataAvailable.mockReturnValue(check.promise);
    const onAvailable = vi.fn();
    const available = protectedData.whenProtectedDataAvailable().then(onAvailable);

    check.resolve(false);
    await check.promise;
    expect(onAvailable).not.toHaveBeenCalled();

    expect(mocks.listeners).toHaveLength(1);
    mocks.listeners[0]?.("active");
    await available;
    expect(onAvailable).toHaveBeenCalledOnce();
    expect(mocks.listeners).toHaveLength(0);
  });

  it("continues a background launch on an unlocked device", async () => {
    mocks.isProtectedDataAvailable.mockResolvedValue(true);
    await protectedData.whenProtectedDataAvailable();
    expect(mocks.listeners).toHaveLength(0);
  });

  it.each(["active", "inactive"])("does not wait for a foreground launch (%s)", async (state) => {
    mocks.appState = state;
    await protectedData.whenProtectedDataAvailable();
    expect(mocks.isProtectedDataAvailable).not.toHaveBeenCalled();
  });
});
