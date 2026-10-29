import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  state: "active",
  listeners: new Set<(state: string) => void>(),
  request: vi.fn<() => Promise<{ granted: boolean; canAskAgain: boolean }>>(),
}));

vi.mock("expo-audio", () => ({ requestRecordingPermissionsAsync: mocks.request }));
vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  AppState: {
    get currentState() {
      return mocks.state;
    },
    addEventListener: (_event: string, listener: (state: string) => void) => {
      mocks.listeners.add(listener);
      return { remove: () => mocks.listeners.delete(listener) };
    },
  },
}));

import { createVoiceRecordingPermission } from "./voiceRecordingPermission";

function changeAppState(state: string) {
  mocks.state = state;
  mocks.listeners.forEach((listener) => listener(state));
}

it.each([true, false])(
  "waits for the permission activity to resume (granted: %s)",
  async (granted) => {
    mocks.state = "active";
    mocks.listeners.clear();
    let finishPermission!: () => void;
    mocks.request.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishPermission = () => resolve({ granted, canAskAgain: true });
        }),
    );
    const interrupted = vi.fn();
    const permission = createVoiceRecordingPermission(interrupted);
    let settled = false;
    const result = permission.requestPermission().then((value) => {
      settled = true;
      return value;
    });
    changeAppState("background");
    expect(interrupted).not.toHaveBeenCalled();
    finishPermission();
    await Promise.resolve();
    expect(settled).toBe(false);
    changeAppState("active");
    expect(await result).toMatchObject({ granted });
    changeAppState("background");
    expect(interrupted).toHaveBeenCalledOnce();
    permission.dispose();
    expect(mocks.listeners.size).toBe(0);
  },
);
