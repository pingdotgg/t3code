import { Fragment, createElement, useEffect, useLayoutEffect, useMemo, type ReactNode } from "react";
import { vi } from "vite-plus/test";

import type { ThreadFeedEntry } from "./threadActivity";
import type { MarkdownImageRenderer } from "../native/SelectableMarkdownText";

const audioValue = ({
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
});
export const audio = audioValue;
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
  AccessibilityInfo: {
    isReduceMotionEnabled: async () => true,
    addEventListener: () => ({ remove() {} }),
  },
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
type ThreadMarkdownVideoModule = typeof import("../features/threads/ThreadMarkdownVideo");
type ClientRuntimeStateModule = typeof import("@t3tools/client-runtime/state/runtime");

vi.mock("../features/threads/ThreadMarkdownVideo", async (importOriginal) => {
  const { createContext } = await import("react");
  const actual = await importOriginal<ThreadMarkdownVideoModule>();
  return {
    ...actual,
    ThreadMediaVisibleContext: createContext(true),
    ThreadMarkdownVideo: (props: Parameters<typeof actual.ThreadMarkdownVideo>[0]) =>
      createElement(actual.ThreadMarkdownVideo, { ...props, thumbnailVisible: true }),
  };
});

vi.mock("@t3tools/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<ClientRuntimeStateModule>()),
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
    FadeInDown: transition,
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
vi.mock("../features/threads/thread-handoff-row", () => ({ ThreadModelSwitchDivider: () => null }));
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
