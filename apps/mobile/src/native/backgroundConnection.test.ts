import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const expoMocks = vi.hoisted(() => ({
  requireOptionalNativeModule: vi.fn((_name: string): unknown => null),
}));

vi.mock("expo", () => ({
  NativeModule: class {
    readonly __nativeModule = true;
  },
  requireOptionalNativeModule: expoMocks.requireOptionalNativeModule,
}));

const runningStatus = {
  supported: true,
  enabled: true,
  serviceRunning: true,
  runtimeReady: true,
  batteryOptimizationIgnored: true,
} as const;

describe("backgroundConnection native bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    expoMocks.requireOptionalNativeModule.mockReturnValue(null);
  });

  it("is safe when the Android native module is unavailable", async () => {
    const bridge = await import("./backgroundConnection");

    expect(bridge.getBackgroundConnectionStatus()).toEqual({
      supported: false,
      enabled: false,
      serviceRunning: false,
      runtimeReady: false,
      batteryOptimizationIgnored: false,
    });
    await expect(bridge.setBackgroundConnectionEnabled(true)).resolves.toMatchObject({
      supported: false,
    });
    await expect(
      bridge.requestBackgroundConnectionBatteryOptimizationExemption(),
    ).resolves.toMatchObject({ supported: false });
    expect(bridge.ensureBackgroundConnectionStarted()).toMatchObject({ supported: false });
    expect(bridge.addBackgroundConnectionStatusListener(vi.fn()).remove).not.toThrow();
    expect(bridge.addBackgroundConnectionStopRequestListener(vi.fn()).remove).not.toThrow();
  });

  it("forwards status and lifecycle calls to the installed native module", async () => {
    const setEnabled = vi.fn(async () => runningStatus);
    const ensureStarted = vi.fn(() => runningStatus);
    const requestBatteryOptimizationExemption = vi.fn(async () => runningStatus);
    const setRuntimeReady = vi.fn(() => runningStatus);
    const acknowledgeStop = vi.fn(() => runningStatus);
    expoMocks.requireOptionalNativeModule.mockReturnValue({
      getStatus: () => runningStatus,
      setEnabled,
      ensureStarted,
      requestBatteryOptimizationExemption,
      setRuntimeReady,
      acknowledgeStop,
    });
    const bridge = await import("./backgroundConnection");

    expect(bridge.getBackgroundConnectionStatus()).toEqual(runningStatus);
    await expect(bridge.setBackgroundConnectionEnabled(true)).resolves.toEqual(runningStatus);
    await expect(bridge.requestBackgroundConnectionBatteryOptimizationExemption()).resolves.toEqual(
      runningStatus,
    );
    expect(bridge.ensureBackgroundConnectionStarted()).toEqual(runningStatus);
    expect(bridge.setBackgroundConnectionRuntimeReady(true)).toEqual(runningStatus);
    expect(bridge.acknowledgeBackgroundConnectionStop()).toEqual(runningStatus);
    expect(setEnabled).toHaveBeenCalledWith(true);
    expect(requestBatteryOptimizationExemption).toHaveBeenCalledOnce();
    expect(ensureStarted).toHaveBeenCalledOnce();
    expect(setRuntimeReady).toHaveBeenCalledWith(true);
    expect(acknowledgeStop).toHaveBeenCalledOnce();
  });

  it("normalizes native status events and exposes the stop request", async () => {
    const listeners = new Map<string, (event?: unknown) => void>();
    const remove = vi.fn();
    expoMocks.requireOptionalNativeModule.mockReturnValue({
      getStatus: () => runningStatus,
      addListener: (eventName: string, listener: (event?: unknown) => void) => {
        listeners.set(eventName, listener);
        return { remove };
      },
    });
    const bridge = await import("./backgroundConnection");
    const onStatus = vi.fn();
    const onStop = vi.fn();

    const statusSubscription = bridge.addBackgroundConnectionStatusListener(onStatus);
    bridge.addBackgroundConnectionStopRequestListener(onStop);
    listeners.get("onStatusChange")?.({
      ...runningStatus,
      runtimeReady: 1,
    });
    listeners.get("onStopRequested")?.();
    statusSubscription.remove();

    expect(onStatus).toHaveBeenCalledWith({ ...runningStatus, runtimeReady: false });
    expect(onStop).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
  });
});
