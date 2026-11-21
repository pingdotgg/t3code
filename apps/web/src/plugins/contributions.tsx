import { createPluginRegistry } from "@t3tools/client-runtime/plugins";
import { ThreadId, type EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type ComponentType,
} from "react";
import { T } from "gt-react";
import { Button } from "~/components/ui/button";
import type {
  CommandPaletteActionItem,
  CommandPaletteSubmenuItem,
} from "~/components/CommandPalette.logic";
import {
  PluginEnvironmentContext,
  PluginSlot,
  definePluginFeature,
  isBuiltinPluginEnabled,
  pluginSharedState,
  useBuiltinPluginRevision,
} from "./features";

export interface PluginActionContext {
  readonly environmentId: EnvironmentId;
  readonly threadRef?: ScopedThreadRef | null;
  readonly navigate: (path: string) => Promise<void>;
}
export interface PluginAction {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly shortcut?: string;
  /** Standalone composer command, without the leading slash (for example, "side"). */
  readonly slashCommand?: string;
  /** Hide composer completion on new drafts and reject invocation until a thread exists. */
  readonly requiresThread?: boolean;
  readonly run: (context: PluginActionContext) => void | Promise<void>;
  readonly getPaletteItem?: () => CommandPaletteActionItem | CommandPaletteSubmenuItem | undefined;
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
export const pluginContributions = pluginSharedState("contributions", () =>
  createPluginRegistry<{
    routes: PluginRoute;
    navigation: PluginNavigationItem;
    actions: PluginAction;
  }>(),
);

export function pluginRoutePath(environmentId: EnvironmentId, pluginId: string, routeId: string) {
  return `/extensions/${encodeURIComponent(pluginId)}/${encodeURIComponent(routeId)}?machine=${encodeURIComponent(environmentId)}`;
}

export function registerBuiltinNavigation(
  pluginId: string,
  items: readonly PluginNavigationItem[],
) {
  pluginContributions.register(
    `${pluginId}/navigation`,
    items.map((item) => ({
      slot: "navigation",
      id: item.id,
      ...(item.order === undefined ? {} : { order: item.order }),
      load: () => item,
    })),
  );
}

export function usePluginContributions<Slot extends "routes" | "navigation" | "actions">(
  slot: Slot,
  environmentId: EnvironmentId | null,
) {
  const entries = useSyncExternalStore(
    pluginContributions.subscribe,
    () => pluginContributions.entries(slot),
    () => pluginContributions.entries(slot),
  );
  useBuiltinPluginRevision();
  return entries
    .filter((entry) =>
      entry.pluginId.includes(":")
        ? entry.pluginId.startsWith(`${environmentId}:`)
        : isBuiltinPluginEnabled(environmentId, entry.pluginId.split("/")[0]!),
    )
    .map((entry) => entry.load());
}

/** Builtin and extension palette actions share the live action registry and cleanup lifecycle. */
export function useRegisteredPaletteItems(
  items: readonly (CommandPaletteActionItem | CommandPaletteSubmenuItem)[],
  environmentId: EnvironmentId | null,
  execute: (item: CommandPaletteActionItem | CommandPaletteSubmenuItem) => void,
) {
  const signature = JSON.stringify(
    items.map((item) => [
      item.value,
      typeof item.title === "string" ? item.title : item.value,
      typeof item.description === "string" ? item.description : null,
      item.disabled,
      item.searchTerms,
      item.kind,
    ]),
  );
  const latest = useRef({ items, execute, signature });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes the committed palette items and executor to a ref read by registered plugin actions
  useLayoutEffect(() => {
    latest.current = { items, execute, signature };
  }, [items, execute, signature]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the palette actions in the plugin contribution registry until the items or environment change
  useEffect(() => {
    if (!environmentId || latest.current.signature !== signature) return;
    return pluginContributions.register(
      `${environmentId}:t3.ui/palette`,
      latest.current.items.map((item) => ({
        slot: "actions",
        id: item.value,
        load: () => ({
          id: item.value,
          title: typeof item.title === "string" ? item.title : item.value,
          ...(typeof item.description === "string" ? { description: item.description } : {}),
          getPaletteItem: () => latest.current.items.find((entry) => entry.value === item.value),
          run: () => {
            const current = latest.current.items.find((entry) => entry.value === item.value);
            if (current) latest.current.execute(current);
          },
        }),
      })),
    );
  }, [environmentId, signature]);
  const registered = usePluginContributions("actions", environmentId);
  const originals = registered
    .filter((action) => action.getPaletteItem)
    .flatMap((action) => {
      const item = items.find((item) => item.value === action.id);
      return item ? [item] : [];
    });
  return {
    builtin: originals.length ? originals : [...items],
    external: registered.filter((action) => !action.getPaletteItem),
  };
}

function BuiltinPluginNavigation({ location }: { readonly location: string }) {
  const environmentId = useContext(PluginEnvironmentContext);
  const items = usePluginContributions("navigation", environmentId).filter(
    (item) => (item.location ?? "sidebar") === location,
  );
  const navigate = useNavigate();
  return (
    <>
      {items.map((item) => (
        <Button
          key={item.id}
          variant="ghost"
          size="sm"
          onClick={() => void navigate({ href: item.path })}
        >
          {item.title}
        </Button>
      ))}
    </>
  );
}
export const PluginNavigation = definePluginFeature("navigation", BuiltinPluginNavigation);

function UnavailablePluginRoute() {
  return (
    <p role="alert" className="p-6 text-muted-foreground">
      <T>This plugin screen is unavailable.</T>
    </p>
  );
}

export function PluginRouteSurface({
  environmentId,
  pluginId,
  routeId,
  path,
  search,
}: PluginRouteProps & { readonly pluginId: string; readonly routeId: string }) {
  const route = usePluginContributions("routes", environmentId).find(
    (entry) => entry.id === `${pluginId}/${routeId}`,
  );
  return route ? (
    <PluginSlot
      slot={`route:${pluginId}/${routeId}`}
      props={{ environmentId, path, search }}
      fallback={UnavailablePluginRoute}
    />
  ) : (
    <p className="p-6 text-muted-foreground">
      <T>Enable the plugin to open this screen.</T>
    </p>
  );
}

export function PluginActionShortcuts() {
  const environmentId = useContext(PluginEnvironmentContext);
  const actions = usePluginContributions("actions", environmentId);
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const threadRef =
    environmentId && params.threadId && params.environmentId === environmentId
      ? { environmentId, threadId: ThreadId.make(params.threadId) }
      : null;
  const current = useRef({ actions, environmentId, navigate, threadRef });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes the committed actions and route to a ref read by the window shortcut listener
  useLayoutEffect(() => {
    current.current = { actions, environmentId, navigate, threadRef };
  }, [actions, environmentId, navigate, threadRef]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window keydown and plugin navigation listeners that run plugin action shortcuts
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const { actions, environmentId, navigate, threadRef } = current.current;
      if (!environmentId || event.defaultPrevented || event.repeat || event.isComposing) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      )
        return;
      const parts = [
        event.metaKey || event.ctrlKey ? "mod" : "",
        event.altKey ? "alt" : "",
        event.shiftKey ? "shift" : "",
        event.key.toLowerCase(),
      ]
        .filter(Boolean)
        .join("+");
      const action = actions.find((entry) => entry.shortcut?.toLowerCase() === parts);
      if (!action || (action.requiresThread && !threadRef)) return;
      event.preventDefault();
      void Promise.resolve()
        .then(() =>
          action.run({ environmentId, threadRef, navigate: (path) => navigate({ href: path }) }),
        )
        .catch((error) => console.error("Plugin action failed", error));
    };
    window.addEventListener("keydown", onKeyDown);
    const onNavigate = (event: Event) => {
      const detail: unknown = (event as CustomEvent<unknown>).detail;
      if (
        detail === null ||
        typeof detail !== "object" ||
        !("environmentId" in detail) ||
        detail.environmentId !== current.current.environmentId ||
        !("path" in detail) ||
        typeof detail.path !== "string"
      )
        return;
      void current.current
        .navigate({ href: detail.path })
        .catch((error) => console.error("Plugin navigation failed", error));
    };
    window.addEventListener("t3:plugin:navigate", onNavigate);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("t3:plugin:navigate", onNavigate);
    };
  }, []);
  return null;
}
