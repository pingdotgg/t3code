import { act } from "react";
import { createRoot } from "react-dom/client";
import type { AppStateStatus } from "react-native";
import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";

const mocks = vi.hoisted(() => ({
  appStateListeners: new Set<(state: AppStateStatus) => void>(),
  refresh: vi.fn<() => Promise<string | null>>(),
  presentVideo: vi.fn<() => Promise<void>>(),
}));
vi.mock("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: (_event: string, listener: (state: AppStateStatus) => void) => {
      mocks.appStateListeners.add(listener);
      return { remove: () => mocks.appStateListeners.delete(listener) };
    },
  },
  Keyboard: { dismiss: () => {} },
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ isFocused: () => true, addListener: () => () => {} }),
}));
vi.mock("expo", () => ({
  requireOptionalNativeModule: () => null,
  requireNativeModule: () => ({
    presentVideo: mocks.presentVideo,
    dismissVideo: async () => {},
    addListener: () => ({ remove() {} }),
  }),
}));
vi.mock("./Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../state/assets", () => ({ refreshAssetUrl: mocks.refresh }));
vi.mock("../../state/session", () => ({ usePreparedConnection: () => ({ _tag: "Some" }) }));
vi.mock("../../lib/localAttachmentPreview", () => ({ loadLocalAttachmentPreview: vi.fn() }));
vi.mock("../../lib/audioSession", () => ({
  acquireAudioSession: () => ({}),
  isAudioSessionOwner: () => true,
  activateAudioSession: async () => true,
  releaseAudioSession: async () => {},
}));

import { VideoPreviewModal } from "./VideoPreviewModal";

it("does not present a video whose loading was interrupted by leaving the app", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const signed = Promise.withResolvers<string | null>();
  mocks.refresh.mockReturnValue(signed.promise);
  mocks.presentVideo.mockResolvedValue();
  const onRequestClose = vi.fn();
  const root = createRoot(document.createElement("div"));
  act(() =>
    root.render(
      <VideoPreviewModal
        source={{
          type: "media",
          name: "clip.mp4",
          mimeType: "video/mp4",
          environmentId: EnvironmentId.make("test"),
          resource: {
            _tag: "github-media",
            cwd: "/project",
            url: "https://github.com/user-attachments/assets/video",
          },
        }}
        onRequestClose={onRequestClose}
      />,
    ),
  );
  act(() => {
    for (const state of ["background", "active"] as const)
      for (const listener of mocks.appStateListeners) listener(state);
  });
  await act(async () => signed.resolve("https://media.example/clip.mp4"));
  expect(mocks.presentVideo).not.toHaveBeenCalled();
  expect(onRequestClose).toHaveBeenCalled();
  act(() => root.unmount());
});
