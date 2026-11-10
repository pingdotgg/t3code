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

it("keeps dictation alive while Android's permission activity backgrounds the app", async () => {
  const permission = Promise.withResolvers<{ granted: boolean; canAskAgain: boolean }>();
  mocks.request.mockReturnValue(permission.promise);
  const interrupted = vi.fn();
  const recording = createVoiceRecordingPermission(interrupted);
  let settled = false;
  const result = recording.requestPermission().then((value) => {
    settled = true;
    return value;
  });

  changeAppState("background");
  permission.resolve({ granted: true, canAskAgain: true });
  await Promise.resolve();
  expect(settled).toBe(false);
  changeAppState("active");
  expect(await result).toMatchObject({ granted: true });
  expect(interrupted).not.toHaveBeenCalled();

  changeAppState("background");
  expect(interrupted).toHaveBeenCalledOnce();
  recording.dispose();
});
