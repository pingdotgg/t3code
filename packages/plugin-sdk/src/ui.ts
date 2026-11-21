import type { Menu as MenuPrimitive } from "@base-ui/react/menu";
import type { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";
import type { useRender } from "@base-ui/react/use-render";
import type { EnvironmentId, ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import type { ComponentProps, ComponentType, ReactNode } from "react";

export interface EmbeddedThreadProps {
  readonly threadRef: ScopedThreadRef;
  readonly contextThreadRef?: ScopedThreadRef;
}

export interface ConversationComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onInterrupt: () => void;
  pending?: boolean;
  busy?: boolean;
  disabled?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  controls?: ReactNode;
}

export interface ConversationMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
  readonly streaming?: boolean;
}

export interface ConversationTimelineProps {
  readonly conversationId: string;
  readonly environmentId: EnvironmentId;
  readonly messages: readonly ConversationMessage[];
  readonly pending?: boolean;
}

export type ComposerBannerVariant = "default" | "error" | "info" | "success" | "warning";
export interface ComposerBannerStackItem {
  readonly id: string;
  readonly variant: ComposerBannerVariant;
  /** The machine's notices sit above the ones that need you. */
  readonly group?: "environment" | "attention";
  readonly icon: ReactNode;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly children?: ReactNode;
  readonly actions?: ReactNode;
  readonly dismissLabel?: string;
  readonly onDismiss?: () => void;
}
export interface ComposerBannerStackProps {
  readonly items: readonly ComposerBannerStackItem[];
  /** Cards stand apart from the composer instead of joining it. */
  readonly detached?: boolean;
}
export type ComposerBannerSurfaceProps = ComponentProps<"div"> & {
  variant?: ComposerBannerVariant;
  detached?: boolean;
};
export type ComposerBannerRootProps = ComposerBannerSurfaceProps & {
  density?: "default" | "comfortable" | "spacious";
  width?: "fill" | "content";
};
export type ComposerBannerRowProps = useRender.ComponentProps<"div"> & {
  layout?: "inline" | "wrap-actions" | "approval";
};
export type ComposerBannerScrollProps = ScrollAreaPrimitive.Root.Props & {
  scrollFade?: boolean;
  scrollFadePadding?: boolean;
  scrollbarGutter?: boolean;
  hideScrollbars?: boolean;
  chainVerticalScroll?: boolean;
  radius?: "inherit" | "none";
  viewportTabIndex?: number;
};
export interface ComposerBannerApi {
  readonly Surface: ComponentType<ComposerBannerSurfaceProps>;
  readonly Attachment: ComponentType<ComponentProps<"div">>;
  readonly Dock: ComponentType<ComponentProps<"div">>;
  readonly Column: ComponentType<ComponentProps<"div">>;
  readonly Root: ComponentType<ComposerBannerRootProps>;
  readonly Row: ComponentType<ComposerBannerRowProps>;
  readonly Icon: ComponentType<ComponentProps<"span">>;
  readonly Content: ComponentType<ComponentProps<"span">>;
  readonly Separator: ComponentType;
  readonly Actions: ComponentType<ComponentProps<"span">>;
  readonly Children: ComponentType<useRender.ComponentProps<"div">>;
  readonly Scroll: ComponentType<ComposerBannerScrollProps>;
  readonly Count: ComponentType<ComponentProps<"span">>;
  readonly Body: ComponentType<ComponentProps<"div">>;
  readonly Dot: ComponentType<ComponentProps<"span">>;
  readonly ToggleIcon: ComponentType<{ expanded: boolean }>;
  readonly Dismiss: ComponentType<ButtonProps>;
}

export type ButtonVariant =
  | "default"
  | "destructive"
  | "destructive-outline"
  | "ghost"
  | "ghost-muted"
  | "ghost-destructive"
  | "glass"
  | "link"
  | "media-close"
  | "media-navigation"
  | "outline"
  | "overlay"
  | "secondary"
  | "warning-outline";
export type ButtonSize =
  | "compact"
  | "default"
  | "icon"
  | "icon-lg"
  | "icon-micro"
  | "icon-tiny"
  | "icon-sm"
  | "icon-xl"
  | "icon-xs"
  | "lg"
  | "micro"
  | "sm"
  | "sm-multiline"
  | "xl"
  | "xs";
export interface ButtonProps extends useRender.ComponentProps<"button"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}
export type MenuPopupProps = MenuPrimitive.Popup.Props &
  Pick<
    MenuPrimitive.Positioner.Props,
    "align" | "sideOffset" | "alignOffset" | "side" | "anchor"
  > & { keepMounted?: boolean };
export type MenuItemProps = MenuPrimitive.Item.Props & {
  inset?: boolean;
  density?: "default" | "touch";
  variant?: "default" | "destructive" | "ghost";
};

export interface ComposerSurfaceApi {
  readonly Shell: ComponentType<ComponentProps<"div"> & { contextStrip?: boolean }>;
  readonly Host: ComponentType<ComponentProps<"div">>;
  readonly Main: ComponentType<ComponentProps<"div">>;
  readonly ContextStrip: ComponentType<ComponentProps<"div">>;
  readonly Body: ComponentType<ComponentProps<"div">>;
  readonly Toolbar: ComponentType<ComponentProps<"div">>;
}

export interface CanvasPanelProps {
  readonly mode: "inline" | "sheet" | "sidebar" | "embedded";
  readonly visible: boolean;
  readonly threadRef: ScopedThreadRef;
  readonly projectId: ProjectId | null;
  readonly surface:
    | {
        readonly id: `canvas:${string}`;
        readonly kind: "canvas";
        readonly documentId: string;
        readonly title?: string;
      }
    | {
        readonly id: "canvas:new";
        readonly kind: "canvas";
        readonly documentId: null;
        readonly title?: undefined;
      };
}

/** High-level building blocks need no app imports; hosts can retain exact lower-level types. */
export interface WebPluginUi<
  ChatPrimitives extends object = object,
  CanvasPrimitives extends object = object,
> {
  readonly Button: ComponentType<ButtonProps>;
  readonly Menu: ComponentType<MenuPrimitive.Root.Props>;
  readonly MenuTrigger: ComponentType<MenuPrimitive.Trigger.Props>;
  readonly MenuPopup: ComponentType<MenuPopupProps>;
  readonly MenuItem: ComponentType<MenuItemProps>;
  readonly canvas: {
    readonly Panel: ComponentType<CanvasPanelProps>;
    readonly FloatingView: ComponentType<{
      readonly threadRef: ScopedThreadRef;
      readonly documentId: string;
    }>;
  } & CanvasPrimitives;
  readonly chat: {
    readonly Thread: ComponentType<EmbeddedThreadProps>;
    readonly Composer: ComponentType<ConversationComposerProps>;
    readonly ComposerSurface: ComposerSurfaceApi;
    readonly Timeline: ComponentType<ConversationTimelineProps>;
    readonly Banner: ComposerBannerApi;
    readonly BannerStack: ComponentType<ComposerBannerStackProps>;
    readonly Topbar: ComponentType<ComponentProps<"header"> & { desktop?: boolean }>;
    readonly Breadcrumb: ComponentType<{
      ariaLabel: string;
      children: ReactNode;
      className?: string;
    }>;
    readonly BreadcrumbItem: ComponentType<{
      children: ReactNode;
      className?: string;
      current?: boolean;
    }>;
    readonly BreadcrumbText: ComponentType<ComponentProps<"span">>;
    readonly BreadcrumbSeparator: ComponentType<{
      readonly className?: string;
      readonly children?: ReactNode;
    }>;
  } & ChatPrimitives;
}
