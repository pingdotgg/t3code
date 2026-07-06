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
  readonly providers?: (context: PluginUiContext) => unknown;
}
