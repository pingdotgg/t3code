import type { ComponentProps, ComponentType } from "react";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";

export type { PluginUiApi } from "./ui";
export type { PluginPanelContext, PluginPanelProps, PluginPanelRegistration } from "./panels";
export type { EmbeddedThreadProps } from "../components/chat/EmbeddedThread";
export type { ConversationComposerProps } from "../components/chat/ConversationComposer";
export type { ComposerBannerStackItem } from "../components/chat/ComposerBannerStack";
export type {
  ConversationMessage,
  ConversationTimelineProps,
} from "../components/chat/ConversationTimeline";

/** Each contribution owns its hooks and renders into the native composer attachment column. */
export interface ComposerBannerContributionProps {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef | null;
}

type SettingsFeature =
  | "settings.layout"
  | "settings.general"
  | "settings.appearance"
  | "settings.projects"
  | "settings.keybindings"
  | "settings.snap-shot"
  | "settings.providers"
  | "settings.browser"
  | "settings.devices"
  | "settings.scheduled-tasks"
  | "settings.source-control"
  | "settings.maintenance"
  | "settings.connections"
  | "settings.access"
  | "settings.archived"
  | "settings.diagnostics"
  | "settings.open-source-licenses"
  | "settings.plugins"
  | "settings.about"
  | "settings.chat"
  | "settings.diffs"
  | "settings.threads"
  | "settings.worktrees"
  | "settings.voice"
  | "settings.labs"
  | "settings.secrets";

/** Open to module augmentation; builtin props are the real client component props. */
export interface PluginFeatureProps extends Record<SettingsFeature, Record<string, never>> {
  "pull-request.page": Record<string, never>;
  "app-layout": ComponentProps<typeof import("../components/AppSidebarLayout").AppSidebarLayout>;
  "command-palette": ComponentProps<typeof import("../components/CommandPalette").CommandPalette>;
  chat: ComponentProps<typeof import("../components/ChatView").default>;
  "chat.route": ComponentProps<typeof import("../components/ThreadRouteView").ThreadRouteView>;
  "chat.header": ComponentProps<typeof import("../components/chat/ChatHeader").ChatHeader>;
  "chat.composer": ComponentProps<typeof import("../components/chat/ChatComposer").ChatComposer>;
  "chat.composer.banners": ComposerBannerContributionProps;
  "chat.canvas": ComponentProps<typeof import("../components/chat/ChatCanvas").ChatCanvas>;
  "chat.timeline": ComponentProps<
    typeof import("../components/chat/MessagesTimeline").MessagesTimeline
  >;
  "chat.details": ComponentProps<
    typeof import("../components/chat/ThreadDetailsPanel").ThreadDetailsPanel
  >;
  "chat.device": ComponentProps<typeof import("../components/device/DevicePanel").DevicePanel>;
  "sidebar.thread": ComponentProps<typeof import("../components/Sidebar").default>;
  "sidebar.settings": ComponentProps<
    typeof import("../components/settings/SettingsSidebarNav").SettingsSidebarNav
  >;
  markdown: ComponentProps<typeof import("../components/ChatMarkdown").default>;
  diff: ComponentProps<typeof import("../components/DiffPanel").default>;
  "file-preview": ComponentProps<typeof import("../components/files/FilePreviewPanel").default>;
  preview: ComponentProps<typeof import("../components/preview/PreviewPanel").PreviewPanel>;
  "canvas.panel": ComponentProps<typeof import("../components/canvas/CanvasPanel").CanvasPanel>;
  "canvas.floating": ComponentProps<
    typeof import("../components/canvas/CanvasFloatingView").CanvasFloatingView
  >;
  "canvas.mini-player": ComponentProps<
    typeof import("../components/preview/ThreadPreviewMiniPlayer").CanvasMiniPlayer
  >;
  "canvas.host": ComponentProps<typeof import("../components/canvas/CanvasHosts").CanvasHosts>;
  "preview.native-host": ComponentProps<
    typeof import("../browser/ElectronBrowserHost").ElectronBrowserHost
  >;
  "pull-request.detail": ComponentProps<
    typeof import("../components/pullRequest/PullRequestDetailPanel").PullRequestDetailPanel
  >;
  "pull-request.thread": ComponentProps<
    typeof import("../components/pullRequest/ThreadPullRequestsPanel").ThreadPullRequestsPanel
  >;
  usage: ComponentProps<typeof import("../components/usage/UsagePage").UsagePage>;
  "app.banner": { threadRef?: ScopedThreadRef | null };
  "chat.banner": { threadRef?: ScopedThreadRef | null };
}

export interface BuiltinRendererApi {
  <Slot extends keyof PluginFeatureProps>(slot: Slot): ComponentType<PluginFeatureProps[Slot]>;
  <Props extends object>(slot: string): ComponentType<Props>;
}
