/**
 * The plugin web SDK: what a plugin needs to BE a plugin.
 *
 * Deliberately self-contained — this entry depends only on `@t3tools/contracts` and
 * `effect`, both of which the host serves through the runtime import map. Nothing here
 * reaches into `apps/web`, which is what makes it consumable outside this repo: a
 * third party can install it, typecheck against it, and ship a plugin.
 *
 * The host's UI components, hooks and atom plumbing live in `./ui` instead, because
 * they re-export live `apps/web` modules and drag the whole app into a consumer's
 * typecheck. See that module for why.
 *
 * @module plugin-sdk-web
 */
import type { PluginId } from "@t3tools/contracts/plugin";
import type { SettingsSchema } from "@t3tools/contracts/pluginSettings";
import { HOST_API_VERSION } from "@t3tools/contracts/plugin";
import type * as Stream from "effect/Stream";
import { pluginSdkWebExternalDependencies } from "./externals";

export { pluginSdkWebExternalDependencies, isPluginSdkWebExternal } from "./externals";

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
  readonly registerMessageAction: (registration: PluginMessageActionRegistration) => void;
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

/**
 * What the host tells a message action about the message it is rendered against.
 *
 * `text` is the message's own content — the plugin already has it, because the whole
 * point is acting on it ("file this as a ticket", "explain this diff"). A plugin
 * without the message text could not do anything useful here.
 */
export interface PluginMessageActionRenderProps {
  readonly pluginId: PluginId;
  readonly threadId: string;
  readonly messageId: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  // The plugin's route base for this environment (`/<env>/p/<pluginId>`), for
  // navigating to plugin routes after the action runs.
  readonly routeBasePath: string | null;
}

/**
 * An action the host renders in a chat message's action row, beside Copy.
 *
 * The plugin returns its own trigger and manages its own UI. Return null to render
 * nothing for a given message — that is how an action scopes itself to assistant
 * messages, or to messages containing a diff, without the host inventing a filter
 * vocabulary it would then have to maintain.
 *
 * A render that throws is contained by the host's surface error boundary: a broken
 * plugin must not take the chat down with it.
 */
export interface PluginMessageActionRegistration {
  readonly id: string;
  readonly render: (props: PluginMessageActionRenderProps) => unknown;
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
  /**
   * Declarative settings for the host-rendered settings page.
   *
   * MUST be the SAME schema module the plugin's SERVER entry declares — export it
   * from one shared file and import it in both. The two entries are bundled
   * separately, so each gets its own copy of the schema object; that is harmless
   * (both are built by the host's Schema classes and every use is structural), but
   * it does mean the host cannot verify they match. The SERVER's schema is
   * authoritative for validation; this copy only renders. If they drift, the form
   * shows fields whose writes the server rejects — contained, but avoidable by
   * sharing the module.
   *
   * The schema must satisfy the renderable field vocabulary; the server rejects a
   * plugin whose schema does not, at registration.
   */
  readonly settings?: { readonly schema: SettingsSchema };
  /**
   * Optional when `settings` is declared: a plugin whose only web surface is a
   * host-rendered settings page has nothing to register imperatively.
   */
  readonly register?: (context: PluginUiContext) => void | Promise<void>;
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
