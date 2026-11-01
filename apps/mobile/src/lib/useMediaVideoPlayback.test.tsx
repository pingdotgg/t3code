import { RegistryContext } from "@effect/atom-react";
import { AtomRegistry } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { AppStateStatus } from "react-native";
import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";

const mocks = vi.hoisted(() => ({
  focused: true,
  appState: "active" as AppStateStatus,
  appStateListeners: new Set<(state: AppStateStatus) => void>(),
  players: [] as ReturnType<typeof createPlayer>[],
  refresh: vi.fn<() => Promise<string | null>>(),
  replace: vi.fn<() => Promise<void>>(),
  thumbnail: vi.fn<(key: string, source: unknown, signal: AbortSignal) => Promise<null>>(),
}));
vi.mock("@react-navigation/native", () => ({ useIsFocused: () => mocks.focused }));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  StyleSheet: { absoluteFill: {} },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
  }) => (
    <button aria-label={accessibilityLabel} onClick={onPress}>
      {children}
    </button>
  ),
  AppState: {
    get currentState() {
      return mocks.appState;
    },
    addEventListener: (_event: string, listener: (state: AppStateStatus) => void) => {
      mocks.appStateListeners.add(listener);
      return { remove: () => mocks.appStateListeners.delete(listener) };
    },
  },
}));
vi.mock("expo", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    requireOptionalNativeModule: () => null,
    useEvent: (player: ReturnType<typeof createPlayer>, event: string, initial: unknown) => {
      const playing = useSyncExternalStore(player.subscribe, () => player.playing);
      return event === "playingChange" ? { isPlaying: playing } : initial;
    },
  };
});
vi.mock("expo-video", async () => {
  const { useState } = await import("react");
  return {
    useVideoPlayer: (
      _source: unknown,
      initialize: (player: ReturnType<typeof createPlayer>) => void,
    ) =>
      useState(() => {
        const player = createPlayer();
        initialize(player);
        mocks.players.push(player);
        return player;
      })[0],
    VideoView: (props: { onFullscreenEnter: () => void; onFullscreenExit: () => void }) => (
      <div aria-label="Video">
        <button aria-label="Enter fullscreen" onClick={props.onFullscreenEnter} />
        <button aria-label="Exit fullscreen" onClick={props.onFullscreenExit} />
      </div>
    ),
  };
});
vi.mock("expo-audio", () => ({
  AudioModule: { setAudioSessionOwner: vi.fn() },
  setAudioModeAsync: vi.fn().mockResolvedValue(undefined),
  setIsAudioActiveAsync: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("expo-image", () => ({ Image: () => null }));
vi.mock("../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../components/MediaActionsMenu", () => ({
  MediaActionsMenu: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("../components/ui/NativePresentation", () => ({
  PresentationSource: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("../state/mediaActions", () => ({
  useMediaActions: () => ({ actions: [], sharing: false }),
}));
vi.mock("../state/assets", () => ({
  useAssetUrlState: () => ({ _tag: "Success", url: "https://media.example/clip.mp4" }),
  useRefreshAssetUrl: () => mocks.refresh,
}));
vi.mock("./localAttachmentPreview", () => ({ loadLocalAttachmentPreview: vi.fn() }));
vi.mock("./videoThumbnails", () => ({
  cachedVideoThumbnail: () => null,
  loadVideoThumbnail: mocks.thumbnail,
}));
vi.mock("../components/FilePreviewGallery", () => ({
  useFilePreviewGallery: () => (value: unknown) => value,
}));
vi.mock("../components/FilePreviewModal", () => ({ FilePreviewModal: () => null }));
vi.mock("../components/VideoPreviewModal", () => ({ VideoPreviewModal: () => null }));
vi.mock("../features/threads/ThreadMarkdownImage", () => ({ ThreadMarkdownImageView: () => null }));

import { ThreadMarkdownVideo } from "../features/threads/ThreadMarkdownVideo";
import {
  PullRequestMedia,
  PullRequestMediaContext,
  PullRequestMediaVisibleContext,
} from "../features/pull-requests/PullRequestMedia";
import { MediaVideoPlayer } from "../components/MediaVideoPlayer";

function createPlayer() {
  let playing = false;
  const listeners = new Set<() => void>();
  const playingListeners = new Set<(event: { isPlaying: boolean }) => void>();
  const setPlaying = (next: boolean) => {
    playing = next;
    for (const listener of listeners) listener();
    for (const listener of playingListeners) listener({ isPlaying: next });
  };
  return {
    currentTime: 0,
    status: "readyToPlay",
    get playing() {
      return playing;
    },
    play: vi.fn(() => setPlaying(true)),
    pause: vi.fn(() => setPlaying(false)),
    replaceAsync: vi.fn(() => mocks.replace()),
    addListener(event: string, listener: (event: { isPlaying: boolean }) => void) {
      if (event === "playingChange") playingListeners.add(listener);
      return { remove: () => playingListeners.delete(listener) };
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function setup(kind: "thread" | "PR" | "files", compact = false) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.focused = true;
  mocks.appState = "active";
  mocks.players = [];
  mocks.appStateListeners.clear();
  mocks.refresh.mockReset().mockResolvedValue("https://media.example/clip.mp4");
  mocks.replace.mockReset().mockResolvedValue();
  mocks.thumbnail.mockReset().mockResolvedValue(null);
  const container = document.createElement("div");
  const root = createRoot(container);
  // Configured like the app's registry: the React default keeps unmounted atoms for 400ms,
  // which would hold thumbnail loads open across renders and tests.
  const registry = AtomRegistry.make();
  const environmentId = EnvironmentId.make("test");
  return {
    render(visible = true) {
      if (kind === "files") mocks.focused = visible;
      act(() =>
        root.render(
          <RegistryContext.Provider value={registry}>
            {kind === "files" ? (
              <MediaVideoPlayer
                name="clip.mp4"
                thumbnailKey="workspace-video:test"
                uri="https://media.example/clip.mp4"
                fitToVideo
                visible={visible}
                resolvePlaybackUri={mocks.refresh}
              />
            ) : kind === "thread" ? (
              <ThreadMarkdownVideo
                thumbnailVisible={visible}
                source={{
                  type: "media",
                  name: "clip.mp4",
                  mimeType: "video/mp4",
                  environmentId,
                  resource: {
                    _tag: "github-media",
                    cwd: "/project",
                    url: "https://github.com/user-attachments/assets/video",
                  },
                }}
              />
            ) : (
              <PullRequestMediaContext value={{ environmentId, cwd: "/project" }}>
                <PullRequestMediaVisibleContext value={visible}>
                  <PullRequestMedia
                    url="https://github.com/user-attachments/assets/video"
                    kind="video"
                    compact={compact}
                  />
                </PullRequestMediaVisibleContext>
              </PullRequestMediaContext>
            )}
          </RegistryContext.Provider>,
        ),
      );
    },
    async open() {
      const button = container.querySelector("button");
      expect(button).not.toBeNull();
      await act(async () => button!.click());
      expect(mocks.players).toHaveLength(1);
      return mocks.players[0]!;
    },
    fullscreen(open: boolean) {
      const button = container.querySelector<HTMLButtonElement>(
        `[aria-label="${open ? "Enter" : "Exit"} fullscreen"]`,
      );
      expect(button).not.toBeNull();
      act(() => button!.click());
    },
    appState(state: AppStateStatus) {
      mocks.appState = state;
      act(() => {
        for (const listener of mocks.appStateListeners) listener(state);
      });
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
      registry.dispose();
    },
  };
}

it.each(["thread", "PR"] as const)(
  "retains the %s player and position while hidden and requires deliberate resume",
  async (kind) => {
    using screen = setup(kind);
    screen.render();
    const player = await screen.open();
    expect(player.playing).toBe(true);
    player.currentTime = 37;
    screen.render(false);
    expect(player.playing).toBe(false);
    screen.render(true);
    expect(mocks.players).toEqual([player]);
    expect(player.replaceAsync).toHaveBeenCalledTimes(1);
    expect(player.currentTime).toBe(37);
    expect(player.playing).toBe(false);
  },
);

it.each(["thread", "PR"] as const)(
  "does not start a hidden %s video when signing or native loading finishes late",
  async (kind) => {
    using screen = setup(kind);
    const signed = Promise.withResolvers<string | null>();
    const replaced = Promise.withResolvers<void>();
    mocks.refresh.mockReturnValue(signed.promise);
    mocks.replace.mockReturnValue(replaced.promise);
    screen.render();
    const player = await screen.open();
    screen.render(false);
    await act(async () => signed.resolve("https://media.example/renewed.mp4"));
    expect(player.replaceAsync).toHaveBeenCalledTimes(1);
    expect(player.play).not.toHaveBeenCalled();
    await act(async () => replaced.resolve());
    expect(player.play).not.toHaveBeenCalled();
    screen.render(true);
    expect(player.playing).toBe(false);
    expect(player.replaceAsync).toHaveBeenCalledTimes(1);
  },
);

it.each([
  ["PR", false],
  ["PR", true],
  ["files", false],
] as const)(
  "stops inactive %s thumbnail requests (compact: %s) and restarts on return",
  async (kind, compact) => {
    using screen = setup(kind, compact);
    mocks.thumbnail.mockReturnValue(new Promise(() => {}));
    screen.render(false);
    expect(mocks.thumbnail).not.toHaveBeenCalled();
    await act(async () => screen.render(true));
    const requests = kind === "files" ? 2 : 1;
    expect(mocks.thumbnail).toHaveBeenCalledTimes(requests);
    const aborted = Promise.all(
      mocks.thumbnail.mock.calls.map(([, , signal]) => {
        expect(signal.aborted).toBe(false);
        return new Promise((resolve) => signal.addEventListener("abort", resolve));
      }),
    );
    screen.render(false);
    await act(() => aborted);
    expect(mocks.thumbnail).toHaveBeenCalledTimes(requests);
    await act(async () => screen.render(true));
    expect(mocks.thumbnail).toHaveBeenCalledTimes(requests * 2);
  },
);

it("pauses on screen blur and app inactivity without resuming on return", async () => {
  using screen = setup("thread");
  screen.render();
  const player = await screen.open();
  for (const reason of ["blur", "inactive", "background"] as const) {
    act(() => player.play());
    player.currentTime = 37;
    if (reason === "blur") {
      mocks.focused = false;
      screen.render();
    } else screen.appState(reason);
    expect(player.playing, reason).toBe(false);
    mocks.focused = true;
    screen.appState("active");
    screen.render();
    expect(player.playing, reason).toBe(false);
    expect(player.currentTime).toBe(37);
  }
  expect(player.replaceAsync).toHaveBeenCalledTimes(1);
});

it.each(["thread", "PR"] as const)(
  "keeps the %s play request cancelled when loading finishes after returning",
  async (kind) => {
    using screen = setup(kind);
    const signed = Promise.withResolvers<string | null>();
    const replaced = Promise.withResolvers<void>();
    mocks.refresh.mockReturnValue(signed.promise);
    mocks.replace.mockReturnValue(replaced.promise);
    screen.render();
    const player = await screen.open();
    screen.render(false);
    screen.render(true);
    await act(async () => signed.resolve("https://media.example/renewed.mp4"));
    await act(async () => replaced.resolve());
    expect(player.replaceAsync).toHaveBeenCalledTimes(1);
    expect(player.play).not.toHaveBeenCalled();
    act(() => player.play());
    expect(player.playing).toBe(true);
  },
);

it("pauses when native fullscreen exits while the app remains in the background", async () => {
  using screen = setup("thread");
  screen.render();
  const player = await screen.open();
  player.currentTime = 37;
  screen.fullscreen(true);
  screen.appState("background");
  expect(player.playing).toBe(true);
  screen.fullscreen(false);
  expect(player.playing).toBe(false);
  screen.appState("active");
  expect(player.playing).toBe(false);
  expect(player.currentTime).toBe(37);
});
