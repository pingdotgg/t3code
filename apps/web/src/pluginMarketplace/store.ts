import type { PluginMarketplaceDetail, PluginMarketplacePlugin } from "@t3tools/contracts";
import { create } from "zustand";

import {
  fetchPluginMarketplaceCatalog,
  fetchPluginMarketplaceDetail,
  installPlugin,
  removePlugin,
} from "./api";

type LoadStatus = "idle" | "loading" | "ready" | "error";

export interface PluginDetailState {
  readonly status: LoadStatus;
  readonly plugin: PluginMarketplaceDetail | null;
  readonly error: string | null;
}

interface PluginMarketplaceStoreState {
  readonly catalogStatus: LoadStatus;
  readonly plugins: ReadonlyArray<PluginMarketplacePlugin>;
  readonly searchHits: ReadonlyArray<PluginMarketplacePlugin>;
  readonly catalogError: string | null;
  readonly details: Readonly<Record<string, PluginDetailState | undefined>>;
  readonly pending: Readonly<Record<string, boolean | undefined>>;
  loadCatalog: (force?: boolean) => Promise<void>;
  searchCatalog: (query: string) => Promise<void>;
  loadDetail: (pluginId: string, force?: boolean) => Promise<void>;
  setInstalled: (pluginId: string, installed: boolean) => Promise<void>;
}

export function pluginMarketplaceErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (typeof error === "object" && error !== null && "detail" in error) {
    const detail = Reflect.get(error, "detail");
    if (typeof detail === "string" && detail.trim().length > 0) return detail;
  }
  return "The plugin marketplaces could not be loaded.";
}

let catalogRequest: Promise<void> | null = null;
let searchRequest: Promise<void> | null = null;
let searchRequestQuery = "";
const detailRequests = new Map<string, Promise<void>>();

export const usePluginMarketplaceStore = create<PluginMarketplaceStoreState>((set, get) => ({
  catalogStatus: "idle",
  plugins: [],
  searchHits: [],
  catalogError: null,
  details: {},
  pending: {},

  loadCatalog: async (force = false) => {
    if (!force && get().catalogStatus === "ready") return;
    const predecessor = catalogRequest;
    if (predecessor && !force) return predecessor;

    const request = (async () => {
      if (predecessor) await predecessor.catch(() => undefined);
      set((state) => ({
        catalogStatus: state.plugins.length > 0 ? "ready" : "loading",
        catalogError: null,
      }));
      try {
        const catalog = await fetchPluginMarketplaceCatalog();
        set({
          catalogStatus: "ready",
          plugins: catalog.plugins,
          catalogError: null,
        });
      } catch (error) {
        set((state) => ({
          catalogStatus: state.plugins.length > 0 ? "ready" : "error",
          catalogError: pluginMarketplaceErrorMessage(error),
        }));
        throw error;
      }
    })();
    catalogRequest = request;
    try {
      await request;
    } finally {
      if (catalogRequest === request) catalogRequest = null;
    }
  },

  searchCatalog: async (query) => {
    const normalized = query.trim();
    if (normalized.length < 2) {
      searchRequestQuery = "";
      set({ searchHits: [] });
      return;
    }
    searchRequestQuery = normalized;
    const request = (async () => {
      const catalog = await fetchPluginMarketplaceCatalog(normalized);
      if (searchRequestQuery !== normalized) return;
      const knownIds = new Set(get().plugins.map((plugin) => plugin.id));
      const plugins = get().plugins.map(
        (plugin) => catalog.plugins.find((entry) => entry.id === plugin.id) ?? plugin,
      );
      set({
        plugins,
        searchHits: catalog.plugins.filter((plugin) => !knownIds.has(plugin.id)),
      });
    })();
    searchRequest = request;
    try {
      await request;
    } finally {
      if (searchRequest === request) searchRequest = null;
    }
  },

  loadDetail: async (pluginId, force = false) => {
    const current = get().details[pluginId];
    if (!force && current?.status === "ready") return;
    const predecessor = detailRequests.get(pluginId);
    if (predecessor && !force) return predecessor;

    const request = (async () => {
      if (predecessor) await predecessor.catch(() => undefined);
      set((state) => ({
        details: {
          ...state.details,
          [pluginId]: {
            status: "loading",
            plugin: state.details[pluginId]?.plugin ?? null,
            error: null,
          },
        },
      }));
      try {
        const plugin = await fetchPluginMarketplaceDetail(pluginId);
        set((state) => ({
          details: {
            ...state.details,
            [pluginId]: { status: "ready", plugin, error: null },
          },
        }));
      } catch (error) {
        set((state) => ({
          details: {
            ...state.details,
            [pluginId]: {
              status: state.details[pluginId]?.plugin ? "ready" : "error",
              plugin: state.details[pluginId]?.plugin ?? null,
              error: pluginMarketplaceErrorMessage(error),
            },
          },
        }));
        throw error;
      }
    })();
    detailRequests.set(pluginId, request);
    try {
      await request;
    } finally {
      if (detailRequests.get(pluginId) === request) detailRequests.delete(pluginId);
    }
  },

  setInstalled: async (pluginId, installed) => {
    set((state) => ({
      pending: {
        ...state.pending,
        [pluginId]: true,
      },
    }));
    try {
      await (installed ? installPlugin(pluginId) : removePlugin(pluginId));
      await get()
        .loadCatalog(true)
        .catch(() => undefined);
      await get()
        .loadDetail(pluginId, true)
        .catch(() => undefined);
    } finally {
      set((state) => ({
        pending: {
          ...state.pending,
          [pluginId]: false,
        },
      }));
    }
  },
}));
