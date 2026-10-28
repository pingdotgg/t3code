import {
  act,
  createElement,
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { inlineFilePreviewKind, isPdfFile } from "./filePreview";
import { ThreadInlineFilePreview } from "../features/threads/ThreadInlineFilePreview";
import { AudioFilePreview } from "../features/files/AudioFilePreview";
import { MediaVideoPlayer } from "../components/MediaVideoPlayer";
import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { acquireAudioSession, activateAudioSession, releaseAudioSession } from "./audioSession";
import { ThreadFeed } from "../features/threads/ThreadFeed";
import type { ThreadFeedEntry } from "./threadActivity";
import type { MarkdownImageRenderer } from "../native/SelectableMarkdownText";

const audio = vi.hoisted(() => ({
  status: {
    playing: false,
    isLoaded: false,
    error: null,
    didJustFinish: false,
    currentTime: 0,
    duration: 10,
    isBuffering: false,
  },
  player: {
    play: vi.fn(),
    pause: vi.fn((_deactivateSession?: boolean) => {}),
    release: vi.fn(),
    replace: vi.fn(),
    seekTo: vi.fn(async () => {}),
  },
  refresh: vi.fn<() => Promise<string | null>>(),
  setAudioMode: vi.fn(async (_mode: unknown) => {}),
  setActive: vi.fn(async (_active: boolean) => {}),
  setSessionOwner: vi.fn((_owned: boolean) => {}),
  sessionOwned: false,
  enabled: true,
  played: vi.fn(),
  video: {
    playing: false,
    playbackRequested: false,
    status: "readyToPlay",
    play: vi.fn(),
    pause: vi.fn(),
    replaceAsync: vi.fn(async (_source: unknown) => {}),
    addListener: vi.fn(),
  },
  videoListeners: new Set<(event: { isPlaying: boolean }) => void>(),
  videoStatusListeners: new Set<(event: { status: string }) => void>(),
  videoEndListeners: new Set<() => void>(),
  videoRequestListeners: new Set<(event: { isPlaybackRequested: boolean }) => void>(),
  navigate: vi.fn(),
  query: vi.fn(),
}));
vi.mock("expo-audio", () => ({
  AudioModule: { setAudioSessionOwner: audio.setSessionOwner },
  useAudioPlayer: () => audio.player,
  createAudioPlayer: () => audio.player,
  useAudioPlayerStatus: () => audio.status,
  setAudioModeAsync: audio.setAudioMode,
  setIsAudioActiveAsync: audio.setActive,
}));
vi.mock("@react-navigation/native", () => ({
  useIsFocused: () => true,
  useNavigation: () => ({ navigate: audio.navigate }),
  useRoute: () => ({ name: "Thread", params: {} }),
  useFocusEffect: (callback: () => (() => void) | undefined) => useEffect(callback, [callback]),
}));
vi.mock("react-native", () => ({
  Platform: { OS: "android", select: (values: { android?: unknown }) => values.android },
  StyleSheet: { create: (styles: unknown) => styles },
  useWindowDimensions: () => ({ width: 390, height: 844, fontScale: 1 }),
  Text: ({ children }: { children?: ReactNode }) => createElement("span", null, children),
  AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) },
  View: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  Pressable: (props: {
    children?: ReactNode;
    onPress: () => void;
    disabled?: boolean;
    accessibilityLabel?: string;
    accessibilityState?: { busy: boolean };
  }) =>
    createElement(
      "button",
      {
        onClick: props.onPress,
        disabled: props.disabled,
        "aria-label": props.accessibilityLabel,
        "aria-busy": props.accessibilityState?.busy,
      },
      props.children,
    ),
}));
vi.mock("../components/PierreEntryIcon", () => ({ PierreEntryIcon: () => null }));
vi.mock("../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => createElement("span", null, children),
}));
vi.mock("../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../components/ui/Button", () => ({
  Button: (props: { label: string; onPress(): void; disabled?: boolean }) =>
    createElement("button", { onClick: props.onPress, disabled: props.disabled }, props.label),
}));
vi.mock("expo", () => ({
  useEvent: (_player: unknown, _event: unknown, initial: unknown) => initial,
  useReleasingSharedObjectWithLifecycle: (
    lifecycle: {
      factory: () => typeof audio.player;
      release: (player: typeof audio.player) => void;
    },
    dependencies: ReadonlyArray<unknown>,
  ) => {
    const player = useMemo(lifecycle.factory, dependencies);
    useEffect(() => () => lifecycle.release(player), [player]);
    return player;
  },
}));
vi.mock("expo-video", () => ({
  useVideoPlayer: () => audio.video,
  VideoView: () => null,
}));
vi.mock("../components/VideoThumbnailImage", () => ({ VideoThumbnailImage: () => null }));
vi.mock("../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../components/MediaActionsMenu", () => ({
  MediaActionsMenu: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("../state/mediaActions", () => ({
  useMediaActions: () => ({ sharing: false, actions: [] }),
}));
vi.mock("./videoAudioSession", () => ({
  useMediaAudioSessionHold() {},
  useFullscreenVideoOpen: () => false,
}));
vi.mock("../state/assets", () => ({
  useRefreshAssetUrl: () => audio.refresh,
  useAssetUrlState: () => ({ _tag: "Success", url: "https://example.com/clip.mp4" }),
  assetEnvironment: {},
}));
vi.mock("../features/threads/ThreadMarkdownVideo", async (importOriginal) => {
  const { createContext } = await import("react");
  const actual = await importOriginal<typeof import("../features/threads/ThreadMarkdownVideo")>();
  return {
    ...actual,
    ThreadMediaVisibleContext: createContext(true),
    ThreadMarkdownVideo: (props: Parameters<typeof actual.ThreadMarkdownVideo>[0]) =>
      createElement(actual.ThreadMarkdownVideo, { ...props, thumbnailVisible: true }),
  };
});

vi.mock("@t3tools/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/runtime")>()),
  executeAtomQuery: (...args: unknown[]) => audio.query(...args),
}));
vi.mock("../state/projects", () => ({
  projectEnvironment: {
    searchEntries: (input: unknown) => input,
    fileMetadata: (input: unknown) => input,
  },
}));
vi.mock("../state/server", () => ({ serverEnvironment: {} }));
vi.mock("../state/session", () => ({
  readEnvironmentScope: () => true,
  usePreparedConnection: () => ({ _tag: "Some", value: { httpBaseUrl: "https://example.com" } }),
}));
vi.mock("../state/atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("../state/threads", () => ({ environmentThreadShells: {}, threadEnvironment: {} }));
vi.mock("../state/entities", () => ({
  useLiveThreadLinkLabels: (text: string) => text,
  useThreadChipIcons: () => new Map(),
}));
vi.mock("../state/use-thread-selection", () => ({
  useThreadSelection: () => ({ selectedThread: null }),
}));
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../state/use-atom-command", () => ({}));
vi.mock("../state/v2-item-support", () => ({}));
vi.mock("../native/SelectableMarkdownText", () => ({
  SelectableMarkdownText: (props: {
    markdown: string;
    onLinkPress(href: string): void;
    renderImage?: MarkdownImageRenderer;
  }) => {
    const embed = props.markdown.match(/!\[([^\]]*)\]\(([^)]+)\)/);
    return createElement(
      "div",
      null,
      createElement("button", { onClick: () => props.onLinkPress("target.ts") }, props.markdown),
      embed && props.renderImage?.({ href: embed[2]!, alt: embed[1]!, title: null }),
    );
  },
}));
vi.mock("@legendapp/list/keyboard", () => ({
  KeyboardAwareLegendList: (props: {
    data: ThreadFeedEntry[];
    renderItem(info: { item: ThreadFeedEntry; index: number }): ReactNode;
  }) =>
    props.data.map((item, index) =>
      createElement("div", { key: item.id }, props.renderItem({ item, index })),
    ),
}));
vi.mock("@legendapp/list/react-native", () => ({
  useViewabilityAmount: (callback: (token: { sizeVisible: number }) => void) =>
    useEffect(() => callback({ sizeVisible: 1 }), [callback]),
}));
vi.mock("react-native-reanimated", () => {
  const transition = { delay: () => transition, duration: () => transition };
  return {
    default: { View: ({ children }: { children?: ReactNode }) => children },
    FadeIn: transition,
    FadeInUp: transition,
  };
});
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock("expo-haptics", () => ({ selectionAsync: async () => {} }));
vi.mock("expo-image", () => ({}));
vi.mock("uniwind", () => ({}));
vi.mock("../components/ui/Dialog", () => ({}));
vi.mock("../components/ui/NativePresentation", () => ({
  PresentationSource: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("../components/ui/Menu", () => ({
  Menu: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("../components/FilePreviewGallery", () => ({
  FilePreviewGallery: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("../components/FilePreviewModal", () => ({
  FilePreviewModal: (props: { source: { name: string } | null }) =>
    props.source ? createElement("div", { "data-file-preview": props.source.name }) : null,
}));
vi.mock("../components/VideoPreviewModal", () => ({ VideoPreviewModal: () => null }));
vi.mock("../components/ComposerContextSheet", () => ({}));
vi.mock("../native/useOpenPullRequest", () => ({ useOpenPullRequest: () => vi.fn() }));
vi.mock("../native/useMarkdownImageSource", () => ({ useMarkdownImageSource: () => vi.fn() }));
vi.mock("../native/useEnrichedLinkVariants", () => ({
  enrichedThreadLinkCustomization: () => undefined,
  enrichedContextLinkCustomization: () => undefined,
  withChipIcon: (value: unknown) => value,
}));
vi.mock("../native/NativeScrollViewMarker", () => ({
  NativeScrollViewMarker: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("../native/NativeWorkspaceColumns", () => ({
  useNativeWorkspaceColumnsSupported: () => false,
}));
vi.mock("../native/native-layout-metrics", () => ({ useDeviceType: () => "phone" }));
vi.mock("../features/layout/workspace-content-width", () => ({
  useWorkspaceSettledContentWidth: () => null,
}));
vi.mock("../features/settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ appearance: { baseFontSize: 14 }, themeAppearance: "dark" }),
}));
vi.mock("./useUniwindTheme", () => ({
  useUniwindTheme: () => new Proxy({}, { get: () => "#000000" }),
}));
vi.mock("./composerContextClipboard", () => ({}));
vi.mock("./copyTextWithHaptic", () => ({}));
vi.mock("./openExternalUrl", () => ({}));
vi.mock("./attachmentDownload", () => ({}));
vi.mock("./uuid", () => ({}));
vi.mock("../features/threads/thread-context-divider", () => ({}));
vi.mock("../features/threads/thread-handoff-row", () => ({}));
vi.mock("../features/threads/ThreadGuestShareBar", () => ({ useThreadGuestShare: () => null }));
vi.mock("../features/threads/SecretRequestCard", () => ({}));
vi.mock("../features/threads/LinkRequestCard", () => ({ LinkRequestCard: () => null }));
vi.mock("../features/threads/worktree-setup-card", () => ({}));
vi.mock("../features/threads/CopyTextButton", () => ({ CopyTextButton: () => null }));
vi.mock("../features/threads/thread-work-log", () => ({ THREAD_DISCLOSURE_TRANSITION_MS: 100 }));
vi.mock("../features/threads/HtmlRenderWebView", () => ({}));
vi.mock("../features/threads/McpAppWebView", () => ({}));
vi.mock("../features/layout/AdaptiveWorkspaceLayout", () => ({
  useAdaptiveWorkspaceLayout: () => ({ fileInspector: { supported: false } }),
}));
vi.mock("../features/threads/thread-workflow-opening", () => ({ useWorkflowOpening: () => null }));
vi.mock("../features/threads/useFileChipShare", () => ({ useFileChipShare: () => vi.fn() }));
vi.mock("../features/threads/ThreadMarkdownImage", async () => {
  const { createContext } = await import("react");
  return { MarkdownImageAvailableWidthContext: createContext(390) };
});
vi.mock("../features/review/ReviewCommentCard", () => ({ useReviewCommentColors: () => ({}) }));
vi.mock("../features/prompt-links/prompt-link-actions", () => ({}));
vi.mock("@react-navigation/elements", async () => {
  const { createContext } = await import("react");
  return { HeaderHeightContext: createContext(0) };
});

describe("ThreadInlineFilePreview playback", () => {
  let root: ReturnType<typeof createRoot> | undefined;
  beforeEach(() => {
    audio.sessionOwned = false;
    audio.setSessionOwner.mockImplementation((owned) => {
      audio.sessionOwned = owned;
    });
    audio.player.pause.mockReset();
    audio.enabled = true;
    audio.setActive.mockImplementation(async (enabled) => {
      audio.enabled = enabled;
    });
    // Expo's play() silently does nothing while its global gate is disabled.
    audio.player.play.mockImplementation(() => {
      if (audio.enabled) audio.played();
    });
    audio.video.addListener.mockImplementation(
      (event: string, listener: (event: { isPlaying: boolean }) => void) => {
        if (event === "playbackRequestedChange") {
          const requestListener = listener as unknown as (event: {
            isPlaybackRequested: boolean;
          }) => void;
          audio.videoRequestListeners.add(requestListener);
          return { remove: () => audio.videoRequestListeners.delete(requestListener) };
        }
        if (event === "statusChange") {
          const statusListener = listener as unknown as (event: { status: string }) => void;
          audio.videoStatusListeners.add(statusListener);
          return { remove: () => audio.videoStatusListeners.delete(statusListener) };
        }
        if (event === "playToEnd") {
          const endListener = listener as unknown as () => void;
          audio.videoEndListeners.add(endListener);
          return { remove: () => audio.videoEndListeners.delete(endListener) };
        }
        audio.videoListeners.add(listener);
        return { remove: () => audio.videoListeners.delete(listener) };
      },
    );
    audio.video.play.mockImplementation(() => {
      audio.video.playing = true;
      audio.video.playbackRequested = true;
      for (const listener of audio.videoRequestListeners) listener({ isPlaybackRequested: true });
      for (const listener of audio.videoListeners) listener({ isPlaying: audio.video.playing });
    });
    audio.video.pause.mockImplementation(() => {
      const wasRequested = audio.video.playbackRequested;
      const wasPlaying = audio.video.playing;
      audio.video.playbackRequested = false;
      audio.video.playing = false;
      if (wasRequested) {
        for (const listener of audio.videoRequestListeners)
          listener({ isPlaybackRequested: false });
      }
      if (wasPlaying) {
        for (const listener of audio.videoListeners) listener({ isPlaying: false });
      }
    });
  });
  afterEach(async () => {
    await act(async () => root?.unmount());
    root = undefined;
    vi.clearAllMocks();
    audio.refresh.mockReset();
    audio.setAudioMode.mockReset();
    audio.setActive.mockReset();
    audio.video.status = "readyToPlay";
    audio.status = {
      playing: false,
      isLoaded: false,
      error: null,
      didJustFinish: false,
      currentTime: 0,
      duration: 10,
      isBuffering: false,
    };
  });

  it.each(
    (["user", "assistant"] as const).flatMap((role) =>
      (["attachment", "markdown"] as const).flatMap((origin) =>
        (["audio", "video"] as const).flatMap((kind) =>
          (kind === "video"
            ? ["initial play", "native resume", "continued playback"]
            : ["initial play"]
          ).map((playback) => ({
            role,
            origin,
            kind,
            playback,
            outcome: playback === "continued playback" ? "preserves" : "cancels",
          })),
        ),
      ),
    ),
  )(
    "$outcome a pending file lookup on $role $origin $kind $playback",
    async ({ role, origin, kind, playback }) => {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      const environmentId = EnvironmentId.make("environment-1");
      const threadId = ThreadId.make("thread-1");
      const messageId = MessageId.make("message-1");
      const timestamp = "2026-10-20T00:00:00.000Z";
      const name = kind === "audio" ? "clip.mp3" : "clip.mp4";
      const mimeType = kind === "audio" ? "audio/mpeg" : "video/mp4";
      const uri = `https://example.com/${name}`;
      const feed: ThreadFeedEntry[] = [
        {
          type: "message",
          id: messageId,
          createdAt: timestamp,
          message: {
            id: messageId,
            role,
            text: `open target.ts${origin === "markdown" ? `\n\n![${name}](${uri})` : ""}`,
            attachments:
              origin === "attachment"
                ? [{ type: "file", id: "clip", name, mimeType, sizeBytes: 12 }]
                : [],
            createdAt: timestamp,
            updatedAt: timestamp,
            runId: null,
            streaming: false,
            visibility: "local",
            sourceThreadId: threadId,
          },
        },
      ];
      let finishLookup!: (value: unknown) => void;
      const lookup = new Promise((resolve) => {
        finishLookup = resolve;
      });
      audio.query
        .mockResolvedValue({ _tag: "Success", value: { kind: "file" } })
        .mockReturnValueOnce(lookup);
      audio.refresh.mockResolvedValue(uri);
      const container = document.createElement("div");
      root = createRoot(container);
      await act(async () =>
        root!.render(
          createElement(ThreadFeed, {
            environmentId,
            threadId,
            detailRef: null,
            threadTitle: "preview",
            workspaceRoot: "/repo",
            feed,
            queuedMessages: [],
            dispatchingMessageId: null,
            onEditPendingMessage: null,
            contentPresentation: { kind: "ready" },
            latestRun: null,
            activeWorkStartedAt: null,
            listRef: { current: null },
            freeze: { value: false } as Parameters<typeof ThreadFeed>[0]["freeze"],
            contentInsetEndAdjustment: { value: 0 } as Parameters<
              typeof ThreadFeed
            >[0]["contentInsetEndAdjustment"],
            anchorMessageId: null,
            keyboardOffset: 0,
          }),
        ),
      );
      const link = Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.startsWith("open target.ts"),
      )!;
      const playLabel = kind === "audio" ? "Play audio" : `Play ${name}`;
      const play = () =>
        container.querySelector<HTMLButtonElement>(`[aria-label="${playLabel}"]`)!.click();
      if (playback !== "initial play") {
        await act(async () => play());
        expect(audio.video.playing).toBe(true);
        if (playback === "native resume") {
          await act(async () => audio.video.pause());
          expect(audio.video.playing).toBe(false);
        } else {
          await act(async () => {
            for (const listener of audio.videoRequestListeners)
              listener({ isPlaybackRequested: true });
          });
        }
      }
      await act(async () => link.click());
      const signal: AbortSignal = audio.query.mock.calls[0]![2].signal;
      expect(signal.aborted).toBe(false);
      expect(audio.navigate).not.toHaveBeenCalled();
      await act(async () => {
        if (playback === "native resume") {
          // Native resume requests playback before buffering advances the clock.
          audio.video.playbackRequested = true;
          for (const listener of audio.videoRequestListeners)
            listener({ isPlaybackRequested: true });
          expect(audio.video.playing).toBe(false);
        } else if (playback === "continued playback") {
          for (const isPlaying of [false, true, false, true]) {
            audio.video.playing = isPlaying;
            for (const listener of audio.videoListeners) listener({ isPlaying });
            for (const listener of audio.videoRequestListeners)
              listener({ isPlaybackRequested: true });
          }
          expect(signal.aborted).toBe(false);
        } else play();
      });
      expect(kind === "audio" ? audio.played : audio.video.play).toHaveBeenCalled();
      expect(audio.sessionOwned).toBe(true);
      await act(async () =>
        finishLookup({
          _tag: "Success",
          value: { entries: [{ path: "src/target.ts", kind: "file" }] },
        }),
      );
      if (playback === "continued playback") {
        expect(audio.navigate).toHaveBeenCalledExactlyOnceWith("ThreadFile", {
          environmentId,
          threadId,
          path: ["src", "target.ts"],
        });
        expect(signal.aborted).toBe(false);
      } else {
        expect(audio.navigate).not.toHaveBeenCalled();
        expect(signal.aborted).toBe(true);
      }
      expect(container.querySelector(`[aria-label="${playLabel}"]`)).toBeNull();
      if (kind === "audio")
        expect(container.querySelector('[aria-label="Pause audio"]')).not.toBeNull();
      else {
        if (playback === "native resume") {
          audio.video.playing = true;
          for (const listener of audio.videoListeners) listener({ isPlaying: true });
        }
        expect(audio.video.playing).toBe(true);
      }
    },
  );

  it.each(
    ["takeover", "pause", "finish"].flatMap((release) => [
      ["inline", "video", release],
      ["viewer", "video", release],
      ["inline", "native video controls", release],
      ["viewer", "native video controls", release],
      ["inline", "recording", release],
      ["viewer", "recording", release],
    ]),
  )(
    "keeps the shared session active when %s audio yields to %s after %s",
    async (source, successor, release) => {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      audio.status = { ...audio.status, isLoaded: true };
      const container = document.createElement("div");
      root = createRoot(container);
      const render = (playVideo = false, showAudio = true) =>
        root!.render(
          createElement(
            "div",
            null,
            showAudio
              ? source === "inline"
                ? createElement(ThreadInlineFilePreview, {
                    source: {
                      kind: "document",
                      name: "sound.mp3",
                      uri: "https://example.com/sound.mp3",
                    },
                    onOpen() {},
                  })
                : createElement(AudioFilePreview, {
                    uri: "https://example.com/sound.mp3",
                    onRetry() {},
                  })
              : null,
            createElement(MediaVideoPlayer, {
              uri: "https://example.com/clip.mp4",
              name: "clip.mp4",
              thumbnailKey: "clip",
              expanded: true,
              autoPlay: playVideo,
            }),
          ),
        );
      await act(async () => render());
      await act(async () =>
        [...container.querySelectorAll("button")]
          .find(
            (button) =>
              button.getAttribute("aria-label") === "Play audio" || button.textContent === "Play",
          )!
          .click(),
      );
      expect(audio.played).toHaveBeenCalledOnce();
      let sessionActive = true;
      const deactivated = vi.fn();
      // Match expo-audio iOS: the queued callback checks ownership at execution time.
      const queueDeactivation = () =>
        setTimeout(() => {
          if (audio.sessionOwned) return;
          sessionActive = false;
          audio.video.playing = false;
          deactivated();
        }, 100);
      audio.setSessionOwner.mockImplementation((owned) => {
        audio.sessionOwned = owned;
        if (!owned) queueDeactivation();
      });
      audio.player.pause.mockImplementation((deactivateSession) => {
        if (deactivateSession !== false) queueDeactivation();
      });
      vi.useFakeTimers();
      let recording: ReturnType<typeof acquireAudioSession> | undefined;
      try {
        if (release === "pause") {
          await act(async () =>
            [...container.querySelectorAll("button")]
              .find(
                (button) =>
                  button.getAttribute("aria-label") === "Pause audio" ||
                  button.textContent === "Pause",
              )!
              .click(),
          );
        } else if (release === "finish") {
          // Native completion queues deactivation before JS receives didJustFinish.
          queueDeactivation();
          audio.status = { ...audio.status, playing: false, didJustFinish: true };
          await act(async () => render());
        }
        if (release !== "takeover") {
          expect(vi.getTimerCount()).toBeGreaterThan(0);
          await vi.advanceTimersByTimeAsync(50);
        }
        await act(async () => {
          if (successor === "recording") {
            recording = acquireAudioSession("recording");
            await activateAudioSession(recording);
          } else if (successor === "native video controls") audio.video.play();
          else render(true);
        });
        if (successor !== "recording") expect(audio.video.playing).toBe(true);
        expect(audio.player.pause).toHaveBeenCalled();
        // Cleanup of the old native ref must not interrupt the successor either.
        await act(async () => render(successor === "video", false));
        await vi.advanceTimersByTimeAsync(200);
        expect(sessionActive).toBe(true);
        expect(deactivated).not.toHaveBeenCalled();
        expect(audio.setActive).not.toHaveBeenCalledWith(false);
        if (successor !== "recording") expect(audio.video.playing).toBe(true);
        else
          expect(audio.setAudioMode).toHaveBeenLastCalledWith(
            expect.objectContaining({ allowsRecording: true }),
          );
        await act(async () => root!.unmount());
        root = undefined;
        if (recording) await releaseAudioSession(recording);
        recording = undefined;
        await vi.advanceTimersByTimeAsync(200);
        expect(sessionActive).toBe(false);
      } finally {
        if (recording) await releaseAudioSession(recording);
        vi.clearAllTimers();
        vi.useRealTimers();
        audio.player.pause.mockReset();
      }
    },
  );

  it.each(["inline", "viewer"])("stops video before starting %s audio", async (source) => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    audio.status = { ...audio.status, isLoaded: true };
    const container = document.createElement("div");
    root = createRoot(container);
    await act(async () =>
      root!.render(
        createElement(
          "div",
          null,
          createElement(MediaVideoPlayer, {
            uri: "https://example.com/clip.mp4",
            name: "clip.mp4",
            thumbnailKey: "clip",
            expanded: true,
            autoPlay: true,
          }),
          source === "inline"
            ? createElement(ThreadInlineFilePreview, {
                source: {
                  kind: "document",
                  name: "sound.mp3",
                  uri: "https://example.com/sound.mp3",
                },
                onOpen() {},
              })
            : createElement(AudioFilePreview, {
                uri: "https://example.com/sound.mp3",
                onRetry() {},
              }),
        ),
      ),
    );
    expect(audio.video.playing).toBe(true);
    audio.video.pause.mockClear();
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find(
          (button) =>
            button.getAttribute("aria-label") === "Play audio" || button.textContent === "Play",
        )!
        .click(),
    );
    expect(audio.video.playing).toBe(false);
    expect(audio.video.pause.mock.invocationCallOrder[0]).toBeLessThan(
      audio.player.play.mock.invocationCallOrder[0]!,
    );
    expect(audio.played).toHaveBeenCalledOnce();
    expect(audio.setActive).toHaveBeenLastCalledWith(true);
  });

  it("plays inline, opens the file viewer, and yields viewer playback to recording", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    audio.status = { ...audio.status, isLoaded: true };
    const container = document.createElement("div");
    root = createRoot(container);
    const openViewer = () =>
      root!.render(
        createElement(AudioFilePreview, { uri: "https://example.com/sound.mp3", onRetry() {} }),
      );
    await act(async () =>
      root!.render(
        createElement(ThreadInlineFilePreview, {
          source: { kind: "document", name: "sound.mp3", uri: "https://example.com/sound.mp3" },
          onOpen: openViewer,
        }),
      ),
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Play audio"]')!.click(),
    );
    expect(audio.played).toHaveBeenCalledOnce();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Open sound.mp3"]')!.click(),
    );
    expect(audio.enabled).toBe(true);
    const play = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Play",
    )!;
    await act(async () => play.click());
    expect(audio.played).toHaveBeenCalledTimes(2);
    audio.player.pause.mockClear();
    let recording!: ReturnType<typeof acquireAudioSession>;
    await act(async () => {
      recording = acquireAudioSession("recording");
    });
    expect(audio.player.pause).toHaveBeenCalledOnce();
    await activateAudioSession(recording);
    await act(async () => play.click());
    expect(audio.played).toHaveBeenCalledTimes(2);
    await releaseAudioSession(recording);
    await act(async () => play.click());
    expect(audio.played).toHaveBeenCalledTimes(3);
    expect(audio.enabled).toBe(true);
  });

  it.each(["pause", "unmount", "recording"])(
    "does not restart the file viewer after %s during replay seeking",
    async (action) => {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      audio.status = { ...audio.status, isLoaded: true, didJustFinish: true, currentTime: 10 };
      const seek = Promise.withResolvers<void>();
      audio.player.seekTo.mockReturnValueOnce(seek.promise);
      const container = document.createElement("div");
      root = createRoot(container);
      await act(async () =>
        root!.render(
          createElement(AudioFilePreview, { uri: "https://example.com/sound.mp3", onRetry() {} }),
        ),
      );
      const play = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Play",
      )!;
      await act(async () => play.click());
      expect(play.textContent).toBe("Pause");
      let recording: ReturnType<typeof acquireAudioSession> | undefined;
      if (action === "pause") await act(async () => play.click());
      else if (action === "recording") {
        await act(async () => {
          recording = acquireAudioSession("recording");
        });
        expect(play.textContent).toBe("Play");
        await activateAudioSession(recording!);
      } else {
        await act(async () => root!.unmount());
        root = undefined;
      }
      await act(async () => seek.resolve());
      expect(audio.played).not.toHaveBeenCalled();
      if (recording) await releaseAudioSession(recording);
    },
  );

  it.each(["buffering", "seek"])(
    "keeps file viewer ownership through %s and native resume",
    async (transition) => {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      audio.status = { ...audio.status, isLoaded: true };
      const container = document.createElement("div");
      root = createRoot(container);
      const render = () =>
        root!.render(
          createElement(AudioFilePreview, {
            uri: "https://example.com/sound.mp3",
            onRetry() {},
          }),
        );
      await act(async () => render());
      await act(async () =>
        [...container.querySelectorAll("button")]
          .find((button) => button.textContent === "Play")!
          .click(),
      );
      audio.status = { ...audio.status, playing: true };
      await act(async () => render());
      audio.player.pause.mockClear();
      if (transition === "seek") {
        await act(async () =>
          [...container.querySelectorAll("button")]
            .find((button) => button.textContent === "+15s")!
            .click(),
        );
        expect(audio.player.seekTo).toHaveBeenCalledWith(10);
      }
      audio.status = { ...audio.status, playing: false, isBuffering: transition === "buffering" };
      await act(async () => render());
      expect(audio.player.pause).not.toHaveBeenCalled();
      expect(
        [...container.querySelectorAll("button")].map((button) => button.textContent),
      ).toContain("Pause");
      audio.status = { ...audio.status, playing: true, isBuffering: false };
      await act(async () => render());
      expect(audio.played).toHaveBeenCalledOnce();
      let recording!: ReturnType<typeof acquireAudioSession>;
      await act(async () => {
        recording = acquireAudioSession("recording");
      });
      expect(audio.player.pause).toHaveBeenCalledOnce();
      await releaseAudioSession(recording);
    },
  );

  it.each(["pause", "pause while buffering", "pause while loading", "end", "error"])(
    "releases file viewer ownership on %s",
    async (action) => {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      audio.status = { ...audio.status, isLoaded: true };
      const container = document.createElement("div");
      root = createRoot(container);
      const render = () =>
        root!.render(
          createElement(AudioFilePreview, {
            uri: "https://example.com/sound.mp3",
            onRetry() {},
          }),
        );
      await act(async () => render());
      await act(async () =>
        [...container.querySelectorAll("button")]
          .find((button) => button.textContent === "Play")!
          .click(),
      );
      audio.status = { ...audio.status, playing: true };
      await act(async () => render());
      if (action.startsWith("pause")) {
        if (action !== "pause") {
          audio.status = {
            ...audio.status,
            playing: false,
            isBuffering: true,
            isLoaded: action !== "pause while loading",
          };
          await act(async () => render());
        }
        await act(async () =>
          [...container.querySelectorAll("button")]
            .find((button) => button.textContent === "Pause")!
            .click(),
        );
      } else {
        audio.status = { ...audio.status, playing: false, didJustFinish: action === "end" };
        if (action === "error") Object.assign(audio.status, { error: "Playback failed" });
        await act(async () => render());
      }
      expect(audio.player.pause).toHaveBeenLastCalledWith();
      audio.status = { ...audio.status, playing: false, isBuffering: false, isLoaded: true };
      await act(async () => render());
      expect(
        [...container.querySelectorAll("button")].map((button) => button.textContent),
      ).toContain("Play");
      audio.player.pause.mockClear();
      const recording = acquireAudioSession("recording");
      expect(audio.player.pause).not.toHaveBeenCalled();
      expect(audio.setActive).not.toHaveBeenCalledWith(false);
      await releaseAudioSession(recording);
    },
  );

  it.each(["buffering", "seek"])(
    "keeps video ownership through %s and resume, including recording takeover during the next wait",
    async (transition) => {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      root = createRoot(document.createElement("div"));
      await act(async () =>
        root!.render(
          createElement(MediaVideoPlayer, {
            uri: "https://example.com/clip.mp4",
            name: "clip.mp4",
            thumbnailKey: "clip",
            expanded: true,
            autoPlay: true,
          }),
        ),
      );
      audio.video.pause.mockClear();
      // iOS can keep readyToPlay during a seek's evaluatingBufferingRate wait.
      if (transition === "buffering") {
        audio.video.status = "loading";
        for (const listener of audio.videoStatusListeners) listener({ status: "loading" });
      }
      audio.video.playing = false;
      for (const listener of audio.videoListeners) listener({ isPlaying: false });
      expect(audio.video.pause).not.toHaveBeenCalled();
      // Buffer readiness can precede the native playing=true event.
      audio.video.status = "readyToPlay";
      for (const listener of audio.videoStatusListeners) listener({ status: "readyToPlay" });
      expect(audio.video.pause).not.toHaveBeenCalled();
      audio.video.playing = true;
      for (const listener of audio.videoListeners) listener({ isPlaying: true });
      expect(audio.video.play).toHaveBeenCalledOnce();
      audio.video.playing = false;
      for (const listener of audio.videoListeners) listener({ isPlaying: false });
      const recording = acquireAudioSession("recording");
      expect(audio.video.pause).toHaveBeenCalledOnce();
      audio.video.play();
      expect(audio.video.playing).toBe(false);
      await releaseAudioSession(recording);
      audio.video.play();
      expect(audio.video.playing).toBe(true);
    },
  );

  it.each(["pause", "pause while buffering", "end", "error"])(
    "releases video ownership on %s",
    async (action) => {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      root = createRoot(document.createElement("div"));
      await act(async () =>
        root!.render(
          createElement(MediaVideoPlayer, {
            uri: "https://example.com/clip.mp4",
            name: "clip.mp4",
            thumbnailKey: "clip",
            expanded: true,
            autoPlay: true,
          }),
        ),
      );
      await act(async () => {
        if (action.startsWith("pause")) {
          if (action === "pause while buffering") {
            audio.video.status = "loading";
            audio.video.playing = false;
            for (const listener of audio.videoListeners) listener({ isPlaying: false });
          }
          audio.video.pause();
        } else if (action === "end") {
          for (const listener of audio.videoEndListeners) listener();
        } else {
          audio.video.status = "error";
          for (const listener of audio.videoStatusListeners) listener({ status: "error" });
        }
      });
      audio.video.pause.mockClear();
      const recording = acquireAudioSession("recording");
      expect(audio.video.pause).not.toHaveBeenCalled();
      await releaseAudioSession(recording);
    },
  );

  it("keeps thread video playback and native controls working after audio releases", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const recording = acquireAudioSession("recording");
    await activateAudioSession(recording);
    await releaseAudioSession(recording);
    const modes = audio.setAudioMode.mock.calls.length;
    const activations = audio.setActive.mock.calls.length;
    const container = document.createElement("div");
    root = createRoot(container);
    await act(async () =>
      root!.render(
        createElement(MediaVideoPlayer, {
          uri: "https://example.com/clip.mp4",
          name: "clip.mp4",
          thumbnailKey: "clip",
          expanded: true,
          autoPlay: true,
        }),
      ),
    );
    expect(audio.video.playing).toBe(true);
    expect(audio.setAudioMode).toHaveBeenCalledTimes(modes);
    expect(audio.setActive).toHaveBeenCalledTimes(activations);
    audio.video.pause();
    audio.video.play();
    expect(audio.video.playing).toBe(true);
    const takeover = acquireAudioSession("recording");
    expect(audio.video.playing).toBe(false);
    await activateAudioSession(takeover);
    audio.video.play();
    expect(audio.video.playing).toBe(false);
    await releaseAudioSession(takeover);
    audio.video.play();
    expect(audio.video.playing).toBe(true);
    await act(async () => root!.unmount());
    root = undefined;
    expect(audio.video.playing).toBe(false);
  });

  it.each(["play", "cancel", "unmount", "mode failure", "activation failure"])(
    "reactivates audio after voice release and honors %s during activation",
    async (intent) => {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      const recording = acquireAudioSession("recording");
      await activateAudioSession(recording);
      await releaseAudioSession(recording);
      vi.clearAllMocks();
      let activate: () => void = () => {};
      if (intent === "mode failure") {
        audio.setAudioMode.mockRejectedValueOnce(new Error("Playback mode unavailable"));
      } else if (intent === "activation failure") {
        audio.setActive.mockRejectedValueOnce(new Error("Audio session unavailable"));
      } else {
        audio.setActive.mockImplementationOnce(
          () => new Promise((resolve) => (activate = resolve)),
        );
      }
      audio.status = { ...audio.status, isLoaded: true };
      const container = document.createElement("div");
      root = createRoot(container);
      act(() =>
        root!.render(
          createElement(ThreadInlineFilePreview, {
            source: { kind: "document", name: "sound.mp3", uri: "https://example.com/sound.mp3" },
            onOpen() {},
          }),
        ),
      );
      const button = container.querySelector<HTMLButtonElement>('button[aria-label="Play audio"]')!;
      await act(async () => button.click());
      expect(audio.setAudioMode).toHaveBeenLastCalledWith({
        allowsRecording: false,
        playsInSilentMode: true,
        interruptionMode: "doNotMix",
        shouldPlayInBackground: false,
      });
      expect(audio.player.play).not.toHaveBeenCalled();
      if (intent.endsWith("failure")) {
        expect(container.textContent).toContain("Unavailable · tap play to retry");
        expect(button.getAttribute("aria-label")).toBe("Retry audio");
        expect(audio.setActive).not.toHaveBeenCalledWith(false);
        return;
      }
      expect(audio.setActive).toHaveBeenLastCalledWith(true);
      expect(audio.setAudioMode.mock.invocationCallOrder[0]).toBeLessThan(
        audio.setActive.mock.invocationCallOrder[0]!,
      );
      if (intent === "cancel") await act(async () => button.click());
      else if (intent === "unmount") {
        act(() => root!.unmount());
        root = undefined;
        expect(audio.player.release).not.toHaveBeenCalled();
      }
      await act(async () => activate());
      if (intent === "play") {
        expect(audio.player.play).toHaveBeenCalledOnce();
        expect(button.getAttribute("aria-label")).toBe("Pause audio");
      } else {
        expect(audio.player.play).not.toHaveBeenCalled();
        expect(audio.setActive).toHaveBeenLastCalledWith(true);
        expect(audio.player.pause).toHaveBeenCalled();
        if (intent === "unmount") {
          expect(audio.player.release).toHaveBeenCalledOnce();
          expect(audio.player.pause.mock.invocationCallOrder[0]).toBeLessThan(
            audio.player.release.mock.invocationCallOrder[0]!,
          );
        }
        if (intent === "cancel") expect(button.getAttribute("aria-label")).toBe("Play audio");
      }
    },
  );

  it.each(["playing", "URL pending", "mode pending", "activation pending"])(
    "yields to recording while %s and plays again after recording stops",
    async (phase) => {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      const url = Promise.withResolvers<string>();
      const native = Promise.withResolvers<void>();
      audio.refresh.mockReturnValueOnce(url.promise);
      audio.status = { ...audio.status, isLoaded: phase !== "URL pending" };
      if (phase === "mode pending") audio.setAudioMode.mockReturnValueOnce(native.promise);
      if (phase === "activation pending") audio.setActive.mockReturnValueOnce(native.promise);
      const container = document.createElement("div");
      root = createRoot(container);
      act(() =>
        root!.render(
          createElement(ThreadInlineFilePreview, {
            source: {
              kind: "document",
              name: "sound.mp3",
              environmentId: EnvironmentId.make("environment-1"),
              resource: {
                _tag: "workspace-file",
                threadId: ThreadId.make("thread-1"),
                path: "/repo/sound.mp3",
              },
            },
            onOpen() {},
          }),
        ),
      );
      const button = container.querySelector<HTMLButtonElement>('button[aria-label="Play audio"]')!;
      await act(async () => button.click());
      expect(audio.player.play).toHaveBeenCalledTimes(phase === "playing" ? 1 : 0);
      expect(audio.refresh).toHaveBeenCalledTimes(phase === "URL pending" ? 1 : 0);
      let recording!: ReturnType<typeof acquireAudioSession>;
      await act(async () => {
        recording = acquireAudioSession("recording");
      });
      expect(audio.player.pause).toHaveBeenCalled();
      expect(button.getAttribute("aria-label")).toBe("Play audio");
      native.resolve();
      await activateAudioSession(recording);
      expect(audio.setAudioMode).toHaveBeenLastCalledWith({
        allowsRecording: true,
        interruptionMode: "doNotMix",
        playsInSilentMode: true,
        shouldPlayInBackground: false,
      });
      const modeCalls = audio.setAudioMode.mock.calls.length;
      const activationCalls = audio.setActive.mock.calls.length;
      await act(async () => url.resolve("https://example.com/sound.mp3"));
      await act(async () => button.click());
      expect(audio.setAudioMode).toHaveBeenCalledTimes(modeCalls);
      expect(audio.setActive).toHaveBeenCalledTimes(activationCalls);
      expect(audio.setActive).not.toHaveBeenCalledWith(false);
      expect(audio.player.play).toHaveBeenCalledTimes(phase === "playing" ? 1 : 0);
      await releaseAudioSession(recording);
      audio.status = { ...audio.status, isLoaded: true };
      // Refresh the native status before the next tap.
      await act(async () =>
        root!.render(
          createElement(ThreadInlineFilePreview, {
            source: { kind: "document", name: "sound.mp3", uri: "https://example.com/sound.mp3" },
            onOpen() {},
          }),
        ),
      );
      const replay = container.querySelector<HTMLButtonElement>('button[aria-label="Play audio"]')!;
      await act(async () => replay.click());
      expect(audio.player.play).toHaveBeenCalledTimes(phase === "playing" ? 2 : 1);
      expect(audio.setAudioMode).toHaveBeenLastCalledWith({
        allowsRecording: false,
        interruptionMode: "doNotMix",
        playsInSilentMode: true,
        shouldPlayInBackground: false,
      });
      expect(audio.setActive).toHaveBeenLastCalledWith(true);
    },
  );

  it.each(["cancel", "unmount", "replay, stale first", "replay, latest first"])(
    "honors the latest audio intent after %s during URL resolution",
    async (intent) => {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      const container = document.createElement("div");
      root = createRoot(container);
      const resolutions: Array<(uri: string) => void> = [];
      audio.refresh.mockImplementation(() => new Promise((resolve) => resolutions.push(resolve)));
      act(() =>
        root!.render(
          createElement(ThreadInlineFilePreview, {
            source: {
              kind: "document",
              name: "sound.mp3",
              environmentId: EnvironmentId.make("environment-1"),
              resource: {
                _tag: "workspace-file",
                threadId: ThreadId.make("thread-1"),
                path: "/repo/sound.mp3",
              },
            },
            onOpen() {},
          }),
        ),
      );
      const button = container.querySelector<HTMLButtonElement>('button[aria-label="Play audio"]')!;
      await act(async () => button.click());
      if (intent !== "unmount") {
        await act(async () => button.click());
        expect(button.getAttribute("aria-label")).toBe("Play audio");
      }
      const replay = intent.startsWith("replay");
      if (replay) {
        await act(async () => button.click());
        expect(button.getAttribute("aria-label")).toBe("Pause audio");
        expect(audio.refresh).toHaveBeenCalledTimes(2);
      } else if (intent === "unmount") {
        act(() => root!.unmount());
        root = undefined;
      }
      const latestFirst = intent === "replay, latest first";
      if (latestFirst) await act(async () => resolutions[1]!("https://example.com/latest.mp3"));
      await act(async () => resolutions[0]!("https://example.com/stale.mp3"));
      expect(audio.player.play).toHaveBeenCalledTimes(latestFirst ? 1 : 0);
      expect(audio.player.replace).toHaveBeenCalledTimes(latestFirst ? 1 : 0);
      if (replay) {
        expect(button.getAttribute("aria-label")).toBe("Pause audio");
        if (!latestFirst) {
          expect(container.textContent).toContain("Loading…");
          await act(async () => resolutions[1]!("https://example.com/latest.mp3"));
        }
        expect(audio.player.replace).toHaveBeenCalledExactlyOnceWith({
          uri: "https://example.com/latest.mp3",
        });
        expect(audio.player.play).toHaveBeenCalledOnce();
      }
    },
  );

  it.each([false, true])(
    "cancels a second tap while buffering with isLoaded=%s",
    async (isLoaded) => {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      const container = document.createElement("div");
      root = createRoot(container);
      audio.status = { ...audio.status, isLoaded, isBuffering: isLoaded };
      let resolve: (uri: string) => void = () => {};
      audio.refresh.mockImplementation(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      const preview = createElement(ThreadInlineFilePreview, {
        source: {
          kind: "document",
          name: "sound.mp3",
          environmentId: EnvironmentId.make("environment-1"),
          resource: {
            _tag: "workspace-file",
            threadId: ThreadId.make("thread-1"),
            path: "/repo/sound.mp3",
          },
        },
        onOpen() {},
      });
      act(() => root!.render(preview));
      const button = container.querySelector<HTMLButtonElement>('button[aria-label="Play audio"]')!;
      await act(async () => button.click());
      expect(audio.player.play).toHaveBeenCalledTimes(isLoaded ? 1 : 0);
      expect(button.disabled).toBe(false);
      expect(button.getAttribute("aria-label")).toBe("Pause audio");
      expect(button.getAttribute("aria-busy")).toBe("true");
      await act(async () => button.click());
      expect(audio.player.pause).toHaveBeenCalled();
      expect(button.getAttribute("aria-label")).toBe("Play audio");
      expect(button.getAttribute("aria-busy")).toBe("false");
      if (!isLoaded) await act(async () => resolve("https://example.com/sound.mp3"));
      expect(audio.player.play).toHaveBeenCalledTimes(isLoaded ? 1 : 0);
      if (!isLoaded) {
        expect(audio.player.replace).not.toHaveBeenCalled();
        audio.refresh.mockResolvedValue("https://example.com/sound.mp3");
      }
      await act(async () => button.click());
      expect(audio.player.play).toHaveBeenCalledTimes(isLoaded ? 2 : 1);
      audio.status = { ...audio.status, isLoaded: true, didJustFinish: true, currentTime: 10 };
      await act(async () =>
        root!.render(createElement(ThreadInlineFilePreview, { ...preview.props })),
      );
      expect(button.getAttribute("aria-label")).toBe("Play audio");
      await act(async () => button.click());
      expect(audio.player.seekTo).toHaveBeenCalledWith(0);
      expect(audio.player.play).toHaveBeenCalledTimes(isLoaded ? 3 : 2);
    },
  );
});

describe("PDF preview detection", () => {
  it.each([
    [{ name: "download", mimeType: "APPLICATION/PDF; charset=binary" }, true],
    [{ name: "https://example.com/report.pdf?signature=abc#page=2" }, true],
    [{ name: "report.pdf", mimeType: "text/plain" }, false],
    [{ name: "https://example.com/page?download=report.pdf" }, false],
  ])("classifies %j as %s", (file, expected) => {
    expect(isPdfFile(file)).toBe(expected);
  });
});

describe("inline file previews", () => {
  it.each([
    [{ name: "sound.MP3" }, "audio"],
    [{ name: "sound", mimeType: "audio/wav" }, "audio"],
    [{ name: "report.PDF", mimeType: "text/plain" }, null],
    [{ name: "report.csv" }, null],
    [{ name: "report.tsv" }, null],
    [{ name: "report", mimeType: "text/csv; charset=utf-8" }, null],
    [{ name: "report.csv", mimeType: "image/png" }, null],
    [{ name: "image.png" }, null],
    [{ name: "clip.mp4" }, null],
    [{ name: "file.zip" }, null],
    [{ name: "report.docx" }, null],
    [{ name: "report.xlsx" }, null],
    [{ name: "report.pptx" }, null],
    [{ name: "download", mimeType: "application/pdf" }, null],
    [{ name: "sound.mp3", mimeType: "application/pdf" }, null],
  ])("classifies %j as %s", (file, expected) => {
    expect(inlineFilePreviewKind(file)).toBe(expected);
  });
});

describe("ThreadFeed previews", () => {
  it("does not commit an open preview over a different thread", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const environmentId = EnvironmentId.make("environment-1");
    const messageId = MessageId.make("message-1");
    const timestamp = "2026-10-20T00:00:00.000Z";
    const feedFor = (threadId: ThreadId): ThreadFeedEntry[] => [
      {
        type: "message",
        id: messageId,
        createdAt: timestamp,
        message: {
          id: messageId,
          role: "user",
          text: "report",
          attachments: [
            {
              type: "file",
              id: "report",
              name: "report.pdf",
              mimeType: "application/pdf",
              sizeBytes: 12,
            },
          ],
          createdAt: timestamp,
          updatedAt: timestamp,
          runId: null,
          streaming: false,
          visibility: "local",
          sourceThreadId: threadId,
        },
      },
    ];
    const container = document.createElement("div");
    // Records what each commit shows before passive effects get a chance to run.
    const committedPreviews: Array<string | null> = [];
    function CommitProbe() {
      useLayoutEffect(() => {
        committedPreviews.push(
          container.querySelector("[data-file-preview]")?.getAttribute("data-file-preview") ?? null,
        );
      });
      return null;
    }
    const element = (
      threadId: ThreadId,
      contentPresentation: Parameters<typeof ThreadFeed>[0]["contentPresentation"] = {
        kind: "ready",
      },
    ) =>
      createElement(
        Fragment,
        null,
        createElement(ThreadFeed, {
          environmentId,
          threadId,
          detailRef: null,
          threadTitle: "preview",
          workspaceRoot: "/repo",
          feed: feedFor(threadId),
          queuedMessages: [],
          dispatchingMessageId: null,
          onEditPendingMessage: null,
          contentPresentation,
          latestRun: null,
          activeWorkStartedAt: null,
          listRef: { current: null },
          freeze: { value: false } as Parameters<typeof ThreadFeed>[0]["freeze"],
          contentInsetEndAdjustment: { value: 0 } as Parameters<
            typeof ThreadFeed
          >[0]["contentInsetEndAdjustment"],
          anchorMessageId: null,
          keyboardOffset: 0,
        }),
        createElement(CommitProbe),
      );
    const root = createRoot(container);
    try {
      await act(async () => root.render(element(ThreadId.make("thread-1"))));
      await act(async () =>
        container.querySelector<HTMLButtonElement>('[aria-label="Open report.pdf"]')!.click(),
      );
      expect(container.querySelector('[data-file-preview="report.pdf"]')).not.toBeNull();
      committedPreviews.length = 0;
      await act(async () => root.render(element(ThreadId.make("thread-2"))));
      expect(committedPreviews[0]).toBeNull();

      // A preview hidden by a presentation change stays closed when the content comes back.
      await act(async () =>
        container.querySelector<HTMLButtonElement>('[aria-label="Open report.pdf"]')!.click(),
      );
      expect(container.querySelector('[data-file-preview="report.pdf"]')).not.toBeNull();
      await act(async () => root.render(element(ThreadId.make("thread-2"), { kind: "loading" })));
      await act(async () => root.render(element(ThreadId.make("thread-2"))));
      expect(container.querySelector("[data-file-preview]")).toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
  });
});
