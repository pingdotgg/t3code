import { PluginSettingsPage } from "./PluginSettingsPage";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type {
  PluginCommandRegistration,
  PluginComponent,
  PluginProjectActionRenderProps,
  PluginRouteComponentProps,
  PluginSettingsComponentProps,
  PluginSidebarSectionRenderProps,
  PluginMessageActionRenderProps,
  PluginUiContext,
  PluginWebDefinition,
  PluginWebRpc,
} from "@t3tools/plugin-sdk-web";
import { PLUGIN_ID_PATTERN_SOURCE, type PluginId, type PluginInfo } from "@t3tools/contracts";
import { findPluginSettingsSchemaViolations } from "@t3tools/shared/pluginSettings";
import { Atom } from "effect/unstable/reactivity";
import { Component, createElement, useEffect, useRef, type ErrorInfo, type ReactNode } from "react";

import { pluginListAtom, pluginRpc } from "../state/plugins";
import { whenPluginHostReady } from "./hostSingletonsReady";

export interface RegisteredPluginRoute {
  readonly pluginId: PluginId;
  readonly path: string;
  readonly component: PluginComponent<PluginRouteComponentProps>;
}

export interface RegisteredPluginSidebarSection {
  readonly pluginId: PluginId;
  readonly id: string;
  readonly title: string;
  readonly render: (props: PluginSidebarSectionRenderProps) => unknown;
}

/**
 * Page id for the host-generated settings page.
 *
 * Namespaced with a `__host_` prefix that plugin page ids cannot produce
 * accidentally, and `registerSettingsPage` rejects it outright — otherwise a
 * plugin registering `{ id: "settings" }` would produce two pages with the same
 * id and last-wins routing. (An earlier comment claimed collision was impossible
 * without anything actually enforcing it.)
 */
export const GENERATED_SETTINGS_PAGE_ID = "__host_settings";

export interface RegisteredPluginSettingsPage {
  readonly pluginId: PluginId;
  readonly id: string;
  readonly title: string;
  readonly component: PluginComponent<PluginSettingsComponentProps>;
}

export interface RegisteredPluginProjectAction {
  readonly pluginId: PluginId;
  readonly id: string;
  readonly render: (props: PluginProjectActionRenderProps) => unknown;
}

export interface RegisteredPluginMessageAction {
  readonly pluginId: PluginId;
  readonly id: string;
  readonly render: (props: PluginMessageActionRenderProps) => unknown;
}

export interface RegisteredPluginCommand extends PluginCommandRegistration {
  readonly pluginId: PluginId;
  readonly context: PluginUiContext;
}

export interface PluginUiRegistrySnapshot {
  readonly routes: ReadonlyArray<RegisteredPluginRoute>;
  readonly sidebarSections: ReadonlyArray<RegisteredPluginSidebarSection>;
  readonly settingsPages: ReadonlyArray<RegisteredPluginSettingsPage>;
  readonly commands: ReadonlyArray<RegisteredPluginCommand>;
  readonly projectActions: ReadonlyArray<RegisteredPluginProjectAction>;
  readonly messageActions: ReadonlyArray<RegisteredPluginMessageAction>;
  readonly failures: Readonly<Record<string, string>>;
}

interface LoadedPlugin {
  readonly pluginId: PluginId;
  readonly version: string;
  /** Catalog lifecycle state at the time of load (`active` / `failed` / …). */
  readonly lifecycleState: PluginInfo["state"];
  readonly routes: ReadonlyArray<RegisteredPluginRoute>;
  readonly sidebarSections: ReadonlyArray<RegisteredPluginSidebarSection>;
  readonly settingsPages: ReadonlyArray<RegisteredPluginSettingsPage>;
  readonly commands: ReadonlyArray<RegisteredPluginCommand>;
  readonly projectActions: ReadonlyArray<RegisteredPluginProjectAction>;
  readonly messageActions: ReadonlyArray<RegisteredPluginMessageAction>;
  readonly failure: string | null;
}

export interface PluginUiHostState {
  readonly loaded: Map<string, LoadedPlugin>;
}

export const EMPTY_PLUGIN_UI_REGISTRY_SNAPSHOT: PluginUiRegistrySnapshot = Object.freeze({
  routes: Object.freeze([]),
  sidebarSections: Object.freeze([]),
  settingsPages: Object.freeze([]),
  commands: Object.freeze([]),
  projectActions: Object.freeze([]),
  messageActions: Object.freeze([]),
  failures: Object.freeze({}),
});

export const pluginUiRegistryAtom = Atom.make<PluginUiRegistrySnapshot>(
  EMPTY_PLUGIN_UI_REGISTRY_SNAPSHOT,
).pipe(Atom.keepAlive, Atom.withLabel("web-plugins:ui-registry"));

export function createPluginUiHostState(): PluginUiHostState {
  return { loaded: new Map() };
}

const PLUGIN_ID_PARAM_PATTERN = new RegExp(`^${PLUGIN_ID_PATTERN_SOURCE}$`);

/**
 * Non-throwing PluginId parse for user-typed route params. URL segments are
 * attacker-controlled and `PluginId.make` THROWS during render on a pattern
 * mismatch — past the plugin surface boundary, into the root errorComponent —
 * so routes must resolve invalid ids to null and fall through to their
 * not-found views instead.
 */
export function parsePluginIdParam(raw: string): PluginId | null {
  return PLUGIN_ID_PARAM_PATTERN.test(raw) ? (raw as PluginId) : null;
}

function normalizePluginPath(path: string): string {
  return path
    .split("/")
    .filter((part) => part.length > 0)
    .join("/");
}

function formatPluginError(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : String(error);
}

function snapshotFromState(state: PluginUiHostState): PluginUiRegistrySnapshot {
  const routes: Array<RegisteredPluginRoute> = [];
  const sidebarSections: Array<RegisteredPluginSidebarSection> = [];
  const settingsPages: Array<RegisteredPluginSettingsPage> = [];
  const commands: Array<RegisteredPluginCommand> = [];
  const projectActions: Array<RegisteredPluginProjectAction> = [];
  const messageActions: Array<RegisteredPluginMessageAction> = [];
  const failures: Record<string, string> = {};

  for (const loaded of state.loaded.values()) {
    if (loaded.failure !== null) {
      failures[loaded.pluginId] = loaded.failure;
      continue;
    }
    routes.push(...loaded.routes);
    sidebarSections.push(...loaded.sidebarSections);
    settingsPages.push(...loaded.settingsPages);
    commands.push(...loaded.commands);
    projectActions.push(...loaded.projectActions);
    messageActions.push(...loaded.messageActions);
  }

  return {
    routes,
    sidebarSections,
    settingsPages,
    commands,
    projectActions,
    messageActions,
    failures,
  };
}

export function getPluginWebEntryUrl(plugin: Pick<PluginInfo, "id" | "version">): string {
  // Slice 2b-2 uses the bundle convention served by PluginWebRoutes.
  return `/plugins/${encodeURIComponent(plugin.id)}/${encodeURIComponent(plugin.version)}/web/index.js`;
}

export function getPluginStylesUrl(
  plugin: Pick<PluginInfo, "id" | "version" | "hasStyles">,
): string | null {
  // A plugin that declares `entries.styles` ships a compiled stylesheet next to
  // its web bundle. The host build only scans host source, so a plugin must ship
  // its own CSS for any classes it uses that the host doesn't.
  return plugin.hasStyles
    ? `/plugins/${encodeURIComponent(plugin.id)}/${encodeURIComponent(plugin.version)}/web/index.css`
    : null;
}

const PLUGIN_STYLE_LINK_ATTR = "data-t3-plugin-styles";
const PLUGIN_STYLE_HREF_ATTR = "data-t3-plugin-styles-href";

/**
 * Reconcile the plugin stylesheet elements for active web plugins that ship
 * styles: inject one per plugin (keyed by id), drop entries for plugins that are
 * no longer active or whose version (href) changed. Idempotent.
 *
 * Each stylesheet is injected as `<style>@import "<url>" layer(plugins)</style>`
 * rather than a bare `<link rel="stylesheet">`. A bare link serves the plugin's
 * raw bytes UNLAYERED, so they beat every host style (which lives in cascade
 * layers) — a plugin shipping a Tailwind preflight would restyle the whole app.
 * `@import ... layer(plugins)` places the plugin's rules into the lowest-priority
 * `plugins` layer declared in the document head, so host styles always win.
 */
function reconcilePluginStyleLinks(activeWebPlugins: ReadonlyArray<PluginInfo>): void {
  if (typeof document === "undefined") {
    return;
  }
  const desired = new Map<string, string>();
  for (const plugin of activeWebPlugins) {
    const url = getPluginStylesUrl(plugin);
    if (url !== null) {
      desired.set(plugin.id, url);
    }
  }
  for (const element of Array.from(
    document.head.querySelectorAll(`style[${PLUGIN_STYLE_LINK_ATTR}]`),
  )) {
    const id = element.getAttribute(PLUGIN_STYLE_LINK_ATTR);
    if (id === null || desired.get(id) !== element.getAttribute(PLUGIN_STYLE_HREF_ATTR)) {
      element.remove();
    }
  }
  for (const [id, url] of desired) {
    if (
      document.head.querySelector(`style[${PLUGIN_STYLE_LINK_ATTR}="${CSS.escape(id)}"]`) === null
    ) {
      const style = document.createElement("style");
      style.setAttribute(PLUGIN_STYLE_LINK_ATTR, id);
      style.setAttribute(PLUGIN_STYLE_HREF_ATTR, url);
      // JSON.stringify yields a valid double-quoted CSS string; the url is built
      // from encodeURIComponent'd id/version so it carries no quotes/backslashes.
      style.textContent = `@import ${JSON.stringify(url)} layer(plugins);`;
      document.head.appendChild(style);
    }
  }
}

function makePluginLogger(pluginId: PluginId): PluginUiContext["logger"] {
  const prefix = `[plugin:${pluginId}]`;
  return {
    debug: (message, data) => console.debug(prefix, message, data),
    info: (message, data) => console.info(prefix, message, data),
    warn: (message, data) => console.warn(prefix, message, data),
    error: (message, data) => console.error(prefix, message, data),
  };
}

function getDefinition(module: unknown): PluginWebDefinition {
  const candidate =
    typeof module === "object" && module !== null && "default" in module
      ? (module as { readonly default?: unknown }).default
      : null;
  if (typeof candidate !== "object" || candidate === null) {
    throw new Error("Plugin web entry does not default-export a defineWebPlugin-shaped object.");
  }
  const hasRegister = "register" in candidate && typeof candidate.register === "function";
  const hasSettings =
    "settings" in candidate &&
    typeof (candidate as { readonly settings?: unknown }).settings === "object" &&
    (candidate as { readonly settings?: unknown }).settings !== null;
  // `register` is optional ONLY when the plugin declares settings: a plugin whose
  // entire web surface is the host-rendered settings page has nothing to register
  // imperatively. An entry with neither is a mistake, not a declarative plugin.
  if (!hasRegister && !hasSettings) {
    throw new Error(
      "Plugin web entry must declare `register`, `settings`, or both (defineWebPlugin-shaped).",
    );
  }
  if ("register" in candidate && candidate.register !== undefined && !hasRegister) {
    throw new Error("Plugin web entry `register` must be a function.");
  }
  return candidate as PluginWebDefinition;
}

async function maybeAwait(value: void | Promise<void>): Promise<void> {
  await value;
}

// Mirrors the server's registrationTimeout in PluginHost (30s). A plugin's
// register() is plugin-controlled code: one that returns a never-settling
// Promise would otherwise block every later plugin in this sync loop AND wedge
// every future sync behind syncChainRef. Bound it so a hung plugin fails via
// the normal per-plugin catch path instead.
const DEFAULT_REGISTER_TIMEOUT_MS = 30_000;

/**
 * Run a plugin's `register(ctx)` bounded by a timeout. Rejects if register does
 * not settle within `timeoutMs`; the caller's per-plugin catch then records the
 * plugin as failed and the loop continues. The timer is always cleared on the
 * fast path so no dangling timers survive (important for tests).
 */
async function registerWithTimeout(
  register: (ctx: PluginUiContext) => void | Promise<void>,
  ctx: PluginUiContext,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`plugin register() timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    await Promise.race([maybeAwait(register(ctx)), timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export interface SyncPluginUiHostRegistrationsInput {
  readonly state: PluginUiHostState;
  readonly plugins: ReadonlyArray<PluginInfo>;
  readonly waitForHost: () => Promise<unknown>;
  readonly importWebPlugin: (url: string) => Promise<unknown>;
  readonly createRpc?: (pluginId: PluginId) => PluginWebRpc;
  /**
   * Per-plugin register() timeout in ms. Defaults to
   * {@link DEFAULT_REGISTER_TIMEOUT_MS}; injectable so tests can drive the
   * timeout path without waiting 30s.
   */
  readonly registerTimeoutMs?: number;
}

export async function syncPluginUiHostRegistrations({
  state,
  plugins,
  waitForHost,
  importWebPlugin,
  createRpc = pluginRpc,
  registerTimeoutMs = DEFAULT_REGISTER_TIMEOUT_MS,
}: SyncPluginUiHostRegistrationsInput): Promise<PluginUiRegistrySnapshot> {
  const activeWebPlugins = plugins.filter((plugin) => plugin.state === "active" && plugin.hasWeb);

  // A plugin that FAILED activation still needs its settings page, because bad
  // settings are often WHY it failed: a plugin that reads `hostApi.settings.get` in
  // register() fails activation on an unreadable or unconfigured row. The server
  // deliberately keeps the declaration reachable for exactly this case, but loading
  // web entries only for `active` plugins made the repair form unreachable — the
  // fallback was correct and no user could get to it.
  //
  // Its module is imported for the DECLARATIVE schema only. `register()` is never
  // called for it below, so none of its imperative surfaces — routes, sidebar,
  // commands, project actions — go live for a plugin the host has rejected.
  const repairableWebPlugins = plugins.filter(
    (plugin) =>
      plugin.state === "failed" && plugin.hasWeb && plugin.capabilities.includes("settings"),
  );
  const loadableWebPlugins = [...activeWebPlugins, ...repairableWebPlugins];
  const loadableKeys = new Set(
    loadableWebPlugins.map((plugin) => `${plugin.id}@${plugin.version}`),
  );

  // Inject/remove each ACTIVE web plugin's stylesheet <link> alongside its JS. A
  // failed plugin gets no stylesheet: the repair form is host-rendered, and its CSS
  // would style surfaces that are not live.
  reconcilePluginStyleLinks(activeWebPlugins);

  for (const [pluginId, loaded] of state.loaded.entries()) {
    if (!loadableKeys.has(`${pluginId}@${loaded.version}`)) {
      state.loaded.delete(pluginId);
    }
  }

  // Reload when never-loaded, previous import FAILED, or the catalog lifecycle
  // state changed (e.g. failed→active after settings repair, or active→failed).
  // Entries are keyed by id@version alone, so without tracking lifecycleState a
  // repaired plugin would keep its failed-state declarative-only load (no
  // register()) and a newly-failed plugin would keep imperative surfaces live.
  const pluginsToLoad = loadableWebPlugins.filter((plugin) => {
    const loaded = state.loaded.get(plugin.id);
    return (
      loaded === undefined || loaded.failure !== null || loaded.lifecycleState !== plugin.state
    );
  });
  if (pluginsToLoad.length > 0) {
    await waitForHost();
  }

  for (const plugin of pluginsToLoad) {
    const routes: Array<RegisteredPluginRoute> = [];
    const sidebarSections: Array<RegisteredPluginSidebarSection> = [];
    const settingsPages: Array<RegisteredPluginSettingsPage> = [];
    const commands: Array<RegisteredPluginCommand> = [];
    const projectActions: Array<RegisteredPluginProjectAction> = [];
    const messageActions: Array<RegisteredPluginMessageAction> = [];

    try {
      const module = await importWebPlugin(getPluginWebEntryUrl(plugin));
      const definition = getDefinition(module);
      const ctx: PluginUiContext = {
        pluginId: plugin.id,
        rpc: createRpc(plugin.id),
        logger: makePluginLogger(plugin.id),
        registerRoute: (registration) => {
          routes.push({
            ...registration,
            pluginId: plugin.id,
            path: normalizePluginPath(registration.path),
          });
        },
        registerSidebarSection: (registration) => {
          sidebarSections.push({ ...registration, pluginId: plugin.id });
        },
        registerSettingsPage: (registration) => {
          // Reserve the generated id: a plugin cannot register a page that would
          // collide with the host's own settings page.
          if (registration.id === GENERATED_SETTINGS_PAGE_ID) {
            throw new Error(
              `settings page id "${GENERATED_SETTINGS_PAGE_ID}" is reserved by the host`,
            );
          }
          settingsPages.push({ ...registration, pluginId: plugin.id });
        },
        registerCommand: (registration) => {
          commands.push({ ...registration, pluginId: plugin.id, context: ctx });
        },
        registerProjectAction: (registration) => {
          projectActions.push({ ...registration, pluginId: plugin.id });
        },
        registerMessageAction: (registration) => {
          messageActions.push({ ...registration, pluginId: plugin.id });
        },
      };
      // Declarative settings become a real settings page rendered by the HOST, so
      // the plugin ships no form. Synthesised BEFORE register() so a plugin that
      // declares both gets its generated page first, then its own pages — and so a
      // plugin declaring only settings still contributes a surface (otherwise the
      // declaration would be inert).
      if (definition.settings !== undefined) {
        // The SERVER validates and stores settings, so a page is only meaningful
        // when the server side actually declares them — which requires the
        // `settings` capability. That capability transitively requires a server
        // entry: the manifest rejects ANY capability on a plugin without one
        // ("web-only plugins may not declare server capabilities"). So this single
        // check also rejects a web-only plugin declaring settings, which would
        // otherwise render a form whose every write fails.
        if (plugin.capabilities.includes("settings")) {
          const settingsSchema = definition.settings.schema;
          // Validate the WEB copy of the schema too, against the same vocabulary the
          // server enforces. The two entries bundle separately, so the server's
          // validation says nothing about what THIS copy contains: a plugin whose
          // server declares `String` while its web declares `Number` passes server
          // activation and then renders a text box that can never be saved. The host
          // cannot prove the copies match, but it can refuse to render one it knows
          // is unrenderable.
          const violations = findPluginSettingsSchemaViolations(settingsSchema, {
            allowPasswordControl: false,
          });
          if (violations.length > 0) {
            ctx.logger.error(
              `web settings schema is not renderable, no settings page rendered: ${violations
                .map((violation) => `${violation.field} ${violation.reason}`)
                .join("; ")}`,
            );
          } else {
            settingsPages.push({
              pluginId: plugin.id,
              id: GENERATED_SETTINGS_PAGE_ID,
              title: "Settings",
              component: () =>
                createElement(PluginSettingsPage, { pluginId: plugin.id, settingsSchema }),
            });
          }
        } else {
          ctx.logger.error(
            "declares web settings but the plugin does not request the `settings` capability (a web-only plugin cannot); no settings page rendered",
          );
        }
      }
      // Optional: a declarative-settings-only plugin has no imperative surface.
      //
      // Skipped entirely for a plugin that failed activation: it is loaded ONLY for
      // the declarative settings schema, so its routes/sidebar/commands must not go
      // live. This is what makes importing a rejected plugin's module safe.
      if (definition.register !== undefined && plugin.state === "active") {
        await registerWithTimeout(definition.register, ctx, registerTimeoutMs);
      }
      state.loaded.set(plugin.id, {
        pluginId: plugin.id,
        version: plugin.version,
        lifecycleState: plugin.state,
        routes,
        sidebarSections,
        settingsPages,
        commands,
        projectActions,
        messageActions,
        failure: null,
      });
    } catch (error) {
      const message = formatPluginError(error);
      console.error(`[plugin:${plugin.id}] failed to register web UI`, error);
      state.loaded.set(plugin.id, {
        pluginId: plugin.id,
        version: plugin.version,
        lifecycleState: plugin.state,
        routes: [],
        sidebarSections: [],
        settingsPages: [],
        commands: [],
        projectActions: [],
        messageActions: [],
        failure: message,
      });
    }
  }

  return snapshotFromState(state);
}

export function resolvePluginRouteRegistration(
  snapshot: PluginUiRegistrySnapshot,
  pluginId: PluginId,
  path: string | null | undefined,
): RegisteredPluginRoute | null {
  const normalizedPath = normalizePluginPath(path ?? "");
  return (
    snapshot.routes.find((route) => route.pluginId === pluginId && route.path === normalizedPath) ??
    null
  );
}

export function resolvePluginSettingsPageRegistration(
  snapshot: PluginUiRegistrySnapshot,
  pluginId: PluginId,
  pageId: string | null | undefined,
): RegisteredPluginSettingsPage | null {
  const normalizedPageId = normalizePluginPath(pageId ?? "");
  return (
    snapshot.settingsPages.find(
      (page) => page.pluginId === pluginId && page.id === normalizedPageId,
    ) ?? null
  );
}

export function PluginUiHost() {
  const plugins = useAtomValue(pluginListAtom);
  const setRegistry = useAtomSet(pluginUiRegistryAtom);
  const stateRef = useRef<PluginUiHostState>(createPluginUiHostState());
  // Single-flight the sync: syncs mutate the shared loaded Map, and two
  // overlapping runs could import + register the same plugin twice. Chain each
  // run after the previous so they never interleave; the latest plugins list
  // always gets applied last.
  const syncChainRef = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    let cancelled = false;
    const run = syncChainRef.current.then(() =>
      syncPluginUiHostRegistrations({
        state: stateRef.current,
        plugins,
        // Publish the host singletons on demand: hostSingletons pulls the full
        // `effect` barrel + `@t3tools/contracts` + the SDK surface, so it is
        // code-split out of the main bundle and only loaded once a web plugin
        // actually needs it. `whenPluginHostReady` resolves when it publishes;
        // a failed chunk load rejects the sync, which the chain logs and the
        // next lifecycle-driven sync retries.
        waitForHost: () => import("./hostSingletons").then(() => whenPluginHostReady),
        importWebPlugin: (url) => import(/* @vite-ignore */ url),
      }).then((snapshot) => {
        if (!cancelled) {
          setRegistry(snapshot);
        }
      }),
    );
    syncChainRef.current = run.catch((error) => {
      console.error("[plugin-ui-host] registry sync failed", error);
    });

    return () => {
      cancelled = true;
    };
  }, [plugins, setRegistry]);

  return null;
}

export interface PluginSurfaceErrorBoundaryProps {
  readonly children: ReactNode;
  readonly label: string;
  // Identity of the rendered plugin surface (e.g. the registered component
  // function). Registry re-syncs re-import a plugin's module, so a changed
  // resetKey means new plugin code — retry rendering instead of staying stuck
  // on the fallback.
  readonly resetKey?: unknown;
}

export class PluginSurfaceErrorBoundary extends Component<
  PluginSurfaceErrorBoundaryProps,
  { readonly error: Error | null }
> {
  override state: { readonly error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[plugin-ui] ${this.props.label} crashed`, error, info);
  }

  // React error boundaries keep their error state until they remount, but this
  // boundary instance can be REUSED for a different surface (TanStack Router
  // does not remount a route component on param-only changes) or for reloaded
  // plugin code (registry re-sync). Reset the error whenever the surface
  // identity changes so one crash doesn't permanently stick the fallback.
  override componentDidUpdate(prevProps: PluginSurfaceErrorBoundaryProps) {
    if (
      this.state.error !== null &&
      (prevProps.label !== this.props.label || prevProps.resetKey !== this.props.resetKey)
    ) {
      // Guarded error-boundary reset: only fires on a surface-identity change, so it cannot loop.
      // eslint-disable-next-line react/no-did-update-set-state
      this.setState({ error: null });
    }
  }

  override render() {
    if (this.state.error) {
      return (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          Plugin surface failed to render.
        </div>
      );
    }
    return this.props.children;
  }
}
