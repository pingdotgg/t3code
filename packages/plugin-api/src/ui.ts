import type {
  EnvironmentId,
  PluginComposerActionId,
  PluginComposerActionPosition,
  PluginCommandName,
  PluginId,
  PluginManifestCatalogEntry,
  PluginSubscriptionEvent,
  PluginRouteId,
  PluginRouteSurface,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import type * as React from "react";

export type { PluginSubscriptionEvent } from "@t3tools/contracts";

export type PluginComponent<Props> = React.JSXElementConstructor<Props>;
export type PluginUiReact = typeof React;
export type PluginUiNode = React.ReactNode;
export type PluginUiStyle = React.CSSProperties;

export type PluginUiButtonVariant = "primary" | "secondary" | "outline" | "ghost" | "danger";
export type PluginUiButtonSize = "xs" | "sm" | "md" | "lg";
export type PluginUiBadgeTone = "default" | "muted" | "success" | "warning" | "danger" | "info";
export type PluginUiTextTone = "default" | "muted" | "success" | "warning" | "danger" | "info";
export type PluginUiTextVariant = "body" | "caption" | "label" | "heading";
export type PluginUiGap = "none" | "xs" | "sm" | "md" | "lg";
export type PluginUiAlign = "start" | "center" | "end" | "stretch";
export type PluginUiJustify = "start" | "center" | "end" | "between";

export const PLUGIN_KEYBINDING_COMMAND_EVENT_TYPE = "t3:plugin-keybinding-command";

export interface PluginKeybindingCommandEventDetail {
  readonly command: string;
  readonly composerId?: string;
}

export interface PluginUiBaseProps {
  readonly children?: PluginUiNode;
  readonly style?: PluginUiStyle;
}

export interface PluginUiPageProps extends PluginUiBaseProps {
  readonly title: string;
  readonly actions?: PluginUiNode;
}

export interface PluginUiToolbarProps extends PluginUiBaseProps {
  readonly trailing?: PluginUiNode;
}

export interface PluginUiSectionProps extends PluginUiBaseProps {
  readonly title?: string;
  readonly description?: string;
  readonly actions?: PluginUiNode;
}

export interface PluginUiSurfaceProps extends PluginUiBaseProps {}

export interface PluginUiStackProps extends PluginUiBaseProps {
  readonly gap?: PluginUiGap;
  readonly align?: PluginUiAlign;
}

export interface PluginUiInlineProps extends PluginUiBaseProps {
  readonly gap?: PluginUiGap;
  readonly align?: Exclude<PluginUiAlign, "stretch">;
  readonly justify?: PluginUiJustify;
  readonly wrap?: boolean;
}

export interface PluginUiTextProps extends PluginUiBaseProps {
  readonly tone?: PluginUiTextTone;
  readonly variant?: PluginUiTextVariant;
  readonly truncate?: boolean;
  readonly title?: string;
}

export interface PluginUiFieldProps extends PluginUiBaseProps {
  readonly label: string;
  readonly description?: string;
}

export interface PluginUiButtonProps extends PluginUiBaseProps {
  readonly variant?: PluginUiButtonVariant;
  readonly size?: PluginUiButtonSize;
  readonly disabled?: boolean;
  readonly title?: string;
  readonly onClick?: () => void;
}

export interface PluginUiLinkProps extends PluginUiBaseProps {
  readonly href: string;
  readonly title?: string;
  readonly onClick?: () => void;
}

export interface PluginUiInputProps {
  readonly value: string;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly autoFocus?: boolean;
  readonly type?: "email" | "number" | "password" | "search" | "text" | "url";
  readonly onValueChange: (value: string) => void;
}

export interface PluginUiTextAreaProps {
  readonly value: string;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly rows?: number;
  readonly onValueChange: (value: string) => void;
}

export interface PluginUiSelectOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface PluginUiSelectProps {
  readonly value: string;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly options: ReadonlyArray<PluginUiSelectOption>;
  readonly onValueChange: (value: string) => void;
}

export interface PluginUiSwitchProps {
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly label?: string;
  readonly onCheckedChange: (checked: boolean) => void;
}

export interface PluginUiBadgeProps extends PluginUiBaseProps {
  readonly tone?: PluginUiBadgeTone;
}

export interface PluginUiDialogProps extends PluginUiBaseProps {
  readonly open: boolean;
  readonly title: string;
  readonly description?: string;
  readonly footer?: PluginUiNode;
  readonly onOpenChange: (open: boolean) => void;
}

export interface PluginUiEmptyStateProps {
  readonly title: string;
  readonly description?: string;
  readonly actions?: PluginUiNode;
}

export interface PluginUiListProps extends PluginUiBaseProps {
  readonly empty?: PluginUiNode;
}

export interface PluginUiListRowProps extends PluginUiBaseProps {
  readonly actions?: PluginUiNode;
}

export interface PluginUiSpinnerProps {
  readonly label?: string;
}

export interface PluginUiComponents {
  readonly Page: PluginComponent<PluginUiPageProps>;
  readonly Toolbar: PluginComponent<PluginUiToolbarProps>;
  readonly Section: PluginComponent<PluginUiSectionProps>;
  readonly Surface: PluginComponent<PluginUiSurfaceProps>;
  readonly Stack: PluginComponent<PluginUiStackProps>;
  readonly Inline: PluginComponent<PluginUiInlineProps>;
  readonly Text: PluginComponent<PluginUiTextProps>;
  readonly Field: PluginComponent<PluginUiFieldProps>;
  readonly Button: PluginComponent<PluginUiButtonProps>;
  readonly Link: PluginComponent<PluginUiLinkProps>;
  readonly Input: PluginComponent<PluginUiInputProps>;
  readonly TextArea: PluginComponent<PluginUiTextAreaProps>;
  readonly Select: PluginComponent<PluginUiSelectProps>;
  readonly Switch: PluginComponent<PluginUiSwitchProps>;
  readonly Badge: PluginComponent<PluginUiBadgeProps>;
  readonly Dialog: PluginComponent<PluginUiDialogProps>;
  readonly EmptyState: PluginComponent<PluginUiEmptyStateProps>;
  readonly List: PluginComponent<PluginUiListProps>;
  readonly ListRow: PluginComponent<PluginUiListRowProps>;
  readonly Spinner: PluginComponent<PluginUiSpinnerProps>;
}

export interface PluginUiProject {
  readonly id: ProjectId;
  readonly name: string;
  readonly environmentId: EnvironmentId;
}

export interface PluginUiApi {
  readonly invoke: <O = unknown>(command: PluginCommandName | string, input: unknown) => Promise<O>;
  readonly subscribe: (
    callback: (event: PluginSubscriptionEvent) => void,
    options?: { readonly onResubscribe?: () => void },
  ) => () => void;
}

export interface PluginUiNavigation {
  readonly navigate: (to: string) => void;
}

export interface PluginUiToasts {
  readonly success: (title: string, description?: string) => void;
  readonly error: (title: string, description?: string) => void;
}

export interface PluginUiHostServices {
  readonly useProjects: () => ReadonlyArray<PluginUiProject>;
  readonly confirm: (message: string) => Promise<boolean>;
  readonly threadHref: (input: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
  }) => string;
}

export interface PluginUiBaseContext {
  readonly pluginId: PluginId;
  readonly catalogEntry: PluginManifestCatalogEntry;
  readonly uiApiVersion: 1;
  readonly react: PluginUiReact;
  readonly api: PluginUiApi;
  readonly host: PluginUiHostServices;
  readonly navigation: PluginUiNavigation;
  readonly toast: PluginUiToasts;
}

export interface PluginUiContext extends PluginUiBaseContext {
  readonly route: {
    readonly id: PluginRouteId;
    readonly surface: PluginRouteSurface;
  };
  readonly components: PluginUiComponents;
}

export interface ComposerPluginActionState {
  readonly blocksSend: boolean;
  readonly label?: string;
  readonly blockingReason?: string;
}

export interface PluginComposerSnapshot {
  readonly value: string;
  readonly cursor: number;
  readonly expandedCursor: number;
}

export interface PluginComposerApi {
  readonly composerId: string;
  readonly insertText: (text: string) => boolean;
  readonly focus: () => void;
  readonly readSnapshot: () => PluginComposerSnapshot;
  readonly setActionState: (state: ComposerPluginActionState) => void;
}

export interface PluginComposerActionContext extends PluginUiBaseContext {
  readonly composerAction: {
    readonly id: PluginComposerActionId;
    readonly position: PluginComposerActionPosition;
  };
  readonly composer: PluginComposerApi;
  readonly components: PluginUiComponents;
}

export interface PluginUiRegistration {
  readonly routes: Record<string, PluginComponent<{ ctx: PluginUiContext }>>;
  readonly composerActions?: Record<string, PluginComponent<{ ctx: PluginComposerActionContext }>>;
}

export type PluginUiFactory = () => PluginUiRegistration;

export interface PluginUiRegistrationOptions {
  readonly assetKey?: string;
}

export interface T3PluginHostGlobal {
  readonly register: (
    pluginId: PluginId | string,
    factory: PluginUiFactory,
    options?: PluginUiRegistrationOptions,
  ) => void;
}

function currentPluginAssetKey(): string | undefined {
  if (typeof document === "undefined") return undefined;
  const currentScript = document.currentScript;
  return currentScript instanceof HTMLScriptElement
    ? currentScript.dataset.t3PluginAssetKey
    : undefined;
}

export function registerPluginUi(
  host: T3PluginHostGlobal,
  pluginId: PluginId | string,
  factory: PluginUiFactory,
): void {
  const assetKey = currentPluginAssetKey();
  host.register(pluginId, factory, assetKey === undefined ? undefined : { assetKey });
}
