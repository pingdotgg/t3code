import type { PluginId } from "@t3tools/contracts/plugin";
import { HOST_API_VERSION } from "@t3tools/contracts/plugin";
import type * as Stream from "effect/Stream";
import { pluginSdkWebExternalDependencies } from "./externals";

export { pluginSdkWebExternalDependencies, isPluginSdkWebExternal } from "./externals";
export { createPluginAtoms, getAppAtomRegistry, getConnectionAtomRuntime } from "./atomAdapter";

export {
  HydrationBoundary,
  RegistryContext,
  RegistryProvider,
  TypeId,
  make,
  scheduleTask,
  useAtom,
  useAtomInitialValues,
  useAtomMount,
  useAtomRef,
  useAtomRefProp,
  useAtomRefPropValue,
  useAtomRefresh,
  useAtomSet,
  useAtomSubscribe,
  useAtomSuspense,
  useAtomValue,
} from "../../../apps/web/src/plugins/pluginSdkAtomReact.ts";
export {
  AsyncResult,
  Atom,
  AtomRegistry,
} from "../../../apps/web/src/plugins/pluginSdkAtomReact.ts";

export * from "../../../apps/web/src/components/ui/alert.tsx";
export * from "../../../apps/web/src/components/ui/alert-dialog.tsx";
export * from "../../../apps/web/src/components/ui/badge.tsx";
export * from "../../../apps/web/src/components/ui/button.tsx";
export * from "../../../apps/web/src/components/ui/card.tsx";
export * from "../../../apps/web/src/components/ui/checkbox.tsx";
export * from "../../../apps/web/src/components/ui/command.tsx";
export * from "../../../apps/web/src/components/ui/dialog.tsx";
export * from "../../../apps/web/src/components/ui/empty.tsx";
export * from "../../../apps/web/src/components/ui/field.tsx";
export * from "../../../apps/web/src/components/ui/input.tsx";
export * from "../../../apps/web/src/components/ui/label.tsx";
export * from "../../../apps/web/src/components/ui/menu.tsx";
export * from "../../../apps/web/src/components/ui/popover.tsx";
export * from "../../../apps/web/src/components/ui/scroll-area.tsx";
export * from "../../../apps/web/src/components/ui/select.tsx";
export * from "../../../apps/web/src/components/ui/separator.tsx";
export * from "../../../apps/web/src/components/ui/sheet.tsx";
export * from "../../../apps/web/src/components/ui/sidebar.tsx";
export * from "../../../apps/web/src/components/ui/spinner.tsx";
export * from "../../../apps/web/src/components/ui/switch.tsx";
export * from "../../../apps/web/src/components/ui/textarea.tsx";
export * from "../../../apps/web/src/components/ui/toast.tsx";
export * from "../../../apps/web/src/components/ui/tooltip.tsx";
export { default as ChatMarkdown } from "../../../apps/web/src/components/ChatMarkdown.tsx";
export { ProviderModelPicker } from "../../../apps/web/src/components/chat/ProviderModelPicker.tsx";
export {
  TraitsMenuContent,
  TraitsPicker,
  shouldRenderTraitsControls,
} from "../../../apps/web/src/components/chat/TraitsPicker.tsx";
export { useAtomCommand } from "../../../apps/web/src/state/use-atom-command.ts";
export { useAtomQueryRunner } from "../../../apps/web/src/state/use-atom-query-runner.ts";
// Environment/project context so a plugin surface can resolve the active
// project(s) for the environment it renders in (e.g. the board list needs a real
// projectId — the environment id is NOT a project id).
export { useEnvironmentProjectRefs } from "../../../apps/web/src/state/entities.ts";
// Schema-error formatting from @t3tools/shared. Re-exported through the SDK
// singleton so plugins don't bundle @t3tools/shared/schemaJson (which imports
// effect/* subpaths the browser import map can't resolve).
export { formatSchemaError } from "@t3tools/shared/schemaJson";

// Host UI/util surface available to plugin web bundles. These are re-exports of
// live host modules — a separately-built plugin externalises
// `@t3tools/plugin-sdk-web`, so at runtime it shares the host's
// singleton instances (React, atoms, settings, provider state) through the import
// map rather than bundling its own copies.
export { cn, randomUUID } from "../../../apps/web/src/lib/utils.ts";
export { useTheme } from "../../../apps/web/src/hooks/useTheme.ts";
export { usePrimarySettings } from "../../../apps/web/src/hooks/useSettings.ts";
export { formatDuration } from "../../../apps/web/src/session-logic.ts";
export { primaryServerProvidersAtom } from "../../../apps/web/src/state/server.ts";
export {
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../../apps/web/src/providerInstances.ts";
export {
  getAppModelOptionsForInstance,
  type AppModelOption,
} from "../../../apps/web/src/modelSelection.ts";
// Diff-rendering stack (ticket diffs). `FileDiff` comes from `@pierre/diffs/react`
// (the host already depends on it for chat diffs) and relies on the host's
// worker-pool context provider being mounted around the app.
export { DiffStatLabel } from "../../../apps/web/src/components/chat/DiffStatLabel.tsx";
export {
  buildFileDiffRenderKey,
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
  type RenderablePatch,
  type DiffThemeName,
} from "../../../apps/web/src/lib/diffRendering.ts";
export { FileDiff } from "@pierre/diffs/react";

export const hostCompat = {
  hostApiVersion: HOST_API_VERSION,
  importMapExternals: pluginSdkWebExternalDependencies,
} as const;

export interface PluginUiContext {
  readonly pluginId: PluginId;
  readonly rpc: PluginWebRpc;
  readonly logger: PluginWebLogger;
  readonly registerRoute: (registration: PluginRouteRegistration) => void;
  readonly registerSidebarSection: (registration: PluginSidebarSectionRegistration) => void;
  readonly registerSettingsPage: (registration: PluginSettingsPageRegistration) => void;
  readonly registerCommand: (registration: PluginCommandRegistration) => void;
  readonly registerProjectAction: (registration: PluginProjectActionRegistration) => void;
}

export interface PluginWebLogger {
  readonly debug: (message: string, data?: unknown) => void;
  readonly info: (message: string, data?: unknown) => void;
  readonly warn: (message: string, data?: unknown) => void;
  readonly error: (message: string, data?: unknown) => void;
}

export interface PluginWebRpc {
  readonly call: (method: string, payload?: unknown) => Promise<unknown>;
  readonly subscribe: (
    method: string,
    payload?: unknown,
  ) => Stream.Stream<unknown, unknown, unknown>;
}

export type PluginComponent<Props = Record<string, never>> = (props: Props) => unknown;

export interface PluginRouteComponentProps {
  readonly pluginId: PluginId;
  readonly path: string;
  // The active environment id from the route (`/<environmentId>/p/<pluginId>/...`),
  // or null if unavailable. Plugin routes need it to scope host-side references
  // (e.g. project/ticket cwd) even though `rpc` is already environment-bound.
  readonly environmentId: string | null;
  // The route's search params (string values), so a plugin route can read its own
  // navigation state (e.g. `?boardId=...&ticket=...`) without touching the host
  // router. Navigate by rendering `<a href>` off the sidebar `routeBasePath`.
  readonly search: Readonly<Record<string, string>>;
}

export interface PluginRouteRegistration {
  readonly path: string;
  readonly component: PluginComponent<PluginRouteComponentProps>;
}

export interface PluginSidebarSectionRenderProps {
  readonly pluginId: PluginId;
  readonly environmentId: string | null;
  readonly routeBasePath: string | null;
}

export interface PluginSidebarSectionRegistration {
  readonly id: string;
  readonly title: string;
  readonly render: (props: PluginSidebarSectionRenderProps) => unknown;
}

export interface PluginProjectActionRenderProps {
  readonly pluginId: PluginId;
  readonly environmentId: string;
  readonly projectId: string;
  readonly projectName: string;
  // The plugin's route base for this environment (`/<env>/p/<pluginId>`), for
  // navigating to plugin routes after the action runs.
  readonly routeBasePath: string | null;
}

// A per-project action the host renders inline in each project row (alongside the
// built-in "New thread" button). The plugin's `render` returns its own trigger
// (e.g. an icon button) and may manage its own dialog; the host provides project
// context. Return null to render nothing for a given project.
export interface PluginProjectActionRegistration {
  readonly id: string;
  readonly render: (props: PluginProjectActionRenderProps) => unknown;
}

export interface PluginSettingsComponentProps {
  readonly pluginId: PluginId;
  readonly pageId: string;
}

export interface PluginSettingsPageRegistration {
  readonly id: string;
  readonly title: string;
  readonly component: PluginComponent<PluginSettingsComponentProps>;
}

export interface PluginCommandRegistration {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly run: (context: PluginUiContext) => void | Promise<void>;
}

export interface PluginWebDefinition {
  readonly register: (context: PluginUiContext) => void | Promise<void>;
}

export function defineWebPlugin<const Definition extends PluginWebDefinition>(
  definition: Definition,
): Definition {
  return definition;
}

/**
 * Tailwind v4 caveat: host builds emit utilities by scanning host source.
 * Separately-built plugins should use host CSS variables and these exported
 * host components, or ship their own compiled CSS for plugin-local classes.
 */
export interface PluginWebRegistration {
  readonly routes?: ReadonlyArray<PluginRouteRegistration>;
  readonly sidebarSections?: ReadonlyArray<PluginSidebarSectionRegistration>;
  readonly settingsPages?: ReadonlyArray<PluginSettingsPageRegistration>;
  readonly commands?: ReadonlyArray<PluginCommandRegistration>;
  readonly projectActions?: ReadonlyArray<PluginProjectActionRegistration>;
  readonly providers?: (context: PluginUiContext) => unknown;
}
