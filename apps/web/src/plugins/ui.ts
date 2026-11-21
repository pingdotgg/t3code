import { ChatTopbar } from "~/components/chat/ChatTopbar";
import type { WebPluginUi } from "@t3tools/plugin-sdk/web";
import { lazy, type LazyExoticComponent } from "react";
import { Button } from "~/components/ui/button";
import { Menu, MenuTrigger, MenuPopup, MenuItem } from "~/components/ui/menu";
import { ComposerSurface } from "~/components/chat/ComposerSurface";
import { ComposerBanner } from "~/components/chat/ComposerBanner";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbText,
  WorkspaceBreadcrumbSeparator,
} from "~/components/WorkspaceBreadcrumb";

const EmbeddedThread = lazy(() =>
  import("~/components/chat/EmbeddedThread").then((module) => ({
    default: module.EmbeddedThread,
  })),
);

const ComposerBannerStack: LazyExoticComponent<
  typeof import("~/components/chat/ComposerBannerStack").ComposerBannerStack
> = lazy(() =>
  import("~/components/chat/ComposerBannerStack").then((module) => ({
    default: module.ComposerBannerStack,
  })),
);

const ConversationComposer = lazy(() =>
  import("~/components/chat/ConversationComposer").then((module) => ({
    default: module.ConversationComposer,
  })),
);
const ConversationTimeline = lazy(() =>
  import("~/components/chat/ConversationTimeline").then((module) => ({
    default: module.ConversationTimeline,
  })),
);
const ComposerPromptEditor = lazy(() =>
  import("~/components/ComposerPromptEditorTiptap").then((module) => ({
    default: module.ComposerPromptEditorTiptap,
  })),
);
const ComposerPrimaryActions: LazyExoticComponent<
  typeof import("~/components/chat/ComposerPrimaryActions").ComposerPrimaryActions
> = lazy(() =>
  import("~/components/chat/ComposerPrimaryActions").then((module) => ({
    default: module.ComposerPrimaryActions,
  })),
);

const CanvasPanel = lazy(() =>
  import("~/components/canvas/CanvasPanel").then((module) => ({ default: module.CanvasPanel })),
);
const CanvasEditor = lazy(() =>
  import("~/components/canvas/CanvasEditor").then((module) => ({ default: module.CanvasEditor })),
);
const CanvasToolbar = lazy(() =>
  import("~/components/canvas/CanvasToolbar").then((module) => ({ default: module.CanvasToolbar })),
);
const CanvasInspector = lazy(() =>
  import("~/components/canvas/CanvasInspector").then((module) => ({
    default: module.CanvasInspector,
  })),
);
const CanvasEmptyState = lazy(() =>
  import("~/components/canvas/CanvasEmptyState").then((module) => ({
    default: module.CanvasEmptyState,
  })),
);
const CanvasFloatingView = lazy(() =>
  import("~/components/canvas/CanvasFloatingView").then((module) => ({
    default: module.CanvasFloatingView,
  })),
);

export interface PluginUiApi extends Pick<WebPluginUi, "chat" | "canvas"> {
  readonly Button: typeof Button;
  readonly Menu: typeof Menu;
  readonly MenuTrigger: typeof MenuTrigger;
  readonly MenuPopup: typeof MenuPopup;
  readonly MenuItem: typeof MenuItem;
  readonly canvas: {
    readonly Panel: typeof CanvasPanel;
    readonly Editor: typeof CanvasEditor;
    readonly Toolbar: typeof CanvasToolbar;
    readonly Inspector: typeof CanvasInspector;
    readonly Picker: typeof CanvasEmptyState;
    readonly FloatingView: typeof CanvasFloatingView;
  };
  readonly chat: {
    readonly Thread: typeof EmbeddedThread;
    readonly Topbar: typeof ChatTopbar;
    readonly Timeline: typeof ConversationTimeline;
    readonly Composer: typeof ConversationComposer;
    readonly ComposerSurface: typeof ComposerSurface;
    readonly Banner: typeof ComposerBanner;
    readonly BannerStack: typeof ComposerBannerStack;
    readonly PromptEditor: typeof ComposerPromptEditor;
    readonly PrimaryActions: typeof ComposerPrimaryActions;
    readonly Breadcrumb: typeof WorkspaceBreadcrumb;
    readonly BreadcrumbItem: typeof WorkspaceBreadcrumbItem;
    readonly BreadcrumbText: typeof WorkspaceBreadcrumbText;
    readonly BreadcrumbSeparator: typeof WorkspaceBreadcrumbSeparator;
  };
}

/** Actual application components: plugin conversations share main-chat presentation. */
export const pluginUi: PluginUiApi = {
  Button,
  Menu,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  canvas: {
    Panel: CanvasPanel,
    Editor: CanvasEditor,
    Toolbar: CanvasToolbar,
    Inspector: CanvasInspector,
    Picker: CanvasEmptyState,
    FloatingView: CanvasFloatingView,
  },
  chat: {
    Thread: EmbeddedThread,
    Topbar: ChatTopbar,
    Timeline: ConversationTimeline,
    Composer: ConversationComposer,
    ComposerSurface,
    Banner: ComposerBanner,
    BannerStack: ComposerBannerStack,
    PromptEditor: ComposerPromptEditor,
    PrimaryActions: ComposerPrimaryActions,
    Breadcrumb: WorkspaceBreadcrumb,
    BreadcrumbItem: WorkspaceBreadcrumbItem,
    BreadcrumbText: WorkspaceBreadcrumbText,
    BreadcrumbSeparator: WorkspaceBreadcrumbSeparator,
  },
};
