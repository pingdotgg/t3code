import type { EnvironmentId, PluginManifest, ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as React from "react";
import type { ComponentType } from "react";
import type { ClientPluginServices, PluginContributionMetadata, PluginDisposer } from "./common.ts";
import type { WebPluginUi } from "./ui.ts";

export type * from "./ui.ts";
export type { ClientPluginServices, PluginDisposer, PluginContributionMetadata } from "./common.ts";

export interface ComposerBannerContributionProps {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef | null;
}

/** Add exact slot props with module augmentation; other loaded slots remain discoverable. */
export interface PluginFeatureProps {
  "chat.composer.banners": ComposerBannerContributionProps;
  "app.banner": { threadRef?: ScopedThreadRef | null };
  "chat.banner": { threadRef?: ScopedThreadRef | null };
}
export interface BuiltinRendererApi {
  <Slot extends keyof PluginFeatureProps>(slot: Slot): ComponentType<PluginFeatureProps[Slot]>;
  <Props extends object>(slot: string): ComponentType<Props>;
}
export interface ClientFeatureContribution<Props extends object = Record<string, unknown>> {
  readonly slot: string;
  readonly id?: string;
  readonly order?: number;
  readonly component: ComponentType<Props>;
}

export interface PluginPanelProps<
  Surface extends object = { readonly id: string; readonly kind: string },
> {
  readonly threadRef: ScopedThreadRef;
  readonly surface?: Surface;
  readonly projectId?: ProjectId | null;
  readonly mode?: "inline" | "sheet" | "sidebar" | "embedded";
  readonly visible?: boolean;
}
export interface PluginPanelContext {
  readonly threadRef?: ScopedThreadRef;
  readonly projectId: ProjectId | null;
}
export interface PluginPanelRegistration<
  Surface extends object = { readonly id: string; readonly kind: string },
> {
  readonly id: string;
  readonly title: string;
  readonly component: ComponentType<PluginPanelProps<Surface>>;
  readonly icon?: ComponentType<{ readonly className?: string }>;
  readonly description?: string;
  readonly shortcut?: string;
  readonly available?: (context: PluginPanelContext) => boolean;
  readonly unavailableReason?: string;
  readonly surfaceKind?: "canvas";
}
export interface PluginRouteProps {
  readonly environmentId: EnvironmentId;
  readonly path: string;
  readonly search: Readonly<Record<string, unknown>>;
}
export interface PluginRoute {
  readonly id: string;
  readonly title: string;
  readonly component: ComponentType<PluginRouteProps>;
}
export interface PluginNavigationItem {
  readonly id: string;
  readonly title: string;
  readonly path: string;
  readonly location?: string;
  readonly order?: number;
  readonly icon?: ComponentType<{ readonly className?: string }>;
}
export interface PluginActionContext {
  readonly environmentId: EnvironmentId;
  readonly threadRef?: ScopedThreadRef | null;
  readonly navigate: (path: string) => Promise<void>;
}
export interface PluginAction<PaletteItem = never> {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly shortcut?: string;
  readonly slashCommand?: string;
  readonly requiresThread?: boolean;
  readonly run: (context: PluginActionContext) => void | Promise<void>;
  readonly getPaletteItem?: () => PaletteItem | undefined;
}

/** The web host also powers Electron's web client; main-process APIs live in /desktop. */
export interface WebPluginHost<
  Ui extends object = WebPluginUi,
  Surface extends object = { readonly id: string; readonly kind: string },
  PaletteItem = never,
> {
  readonly React: typeof React;
  readonly Effect: typeof Effect;
  readonly environmentId: EnvironmentId;
  readonly manifest: PluginManifest;
  readonly builtin: BuiltinRendererApi;
  readonly ui: Ui;
  readonly features: () => readonly PluginContributionMetadata[];
  readonly register: <Props extends object>(
    contributions: readonly ClientFeatureContribution<Props>[],
  ) => void;
  readonly style: (css: string) => void;
  readonly onDispose: (dispose: PluginDisposer) => void;
  readonly panels: {
    readonly register: (panels: readonly PluginPanelRegistration<Surface>[]) => void;
    readonly open: (threadRef: ScopedThreadRef, id: string) => void;
  };
  readonly routes: {
    readonly register: (routes: readonly PluginRoute[]) => void;
    readonly path: (routeId: string) => string;
  };
  readonly navigation: {
    readonly register: (items: readonly PluginNavigationItem[]) => void;
    readonly open: (path: string) => void;
  };
  readonly actions: { readonly register: (actions: readonly PluginAction<PaletteItem>[]) => void };
  readonly services: ClientPluginServices & { readonly host: ClientPluginServices };
  readonly invoke: (method: string, input?: unknown) => Promise<unknown>;
  readonly desktop: {
    readonly invoke: (method: string, input?: unknown) => Promise<unknown>;
  } | null;
}
export type ClientPluginSdk<
  Ui extends object = WebPluginUi,
  Surface extends object = { readonly id: string; readonly kind: string },
  PaletteItem = never,
> = WebPluginHost<Ui, Surface, PaletteItem>;
export interface WebPluginDefinition<Host = WebPluginHost> {
  readonly activate: (host: Host) => void | PluginDisposer | Promise<void | PluginDisposer>;
}
