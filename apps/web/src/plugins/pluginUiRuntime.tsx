import {
  PluginCommandName,
  type PluginComposerActionContribution,
  type PluginRouteId,
  type PluginRouteSurface,
} from "@t3tools/contracts";
import type {
  ComposerPluginActionState,
  PluginComposerActionContext,
  PluginComposerApi,
  PluginUiBaseContext,
  PluginUiContext,
  PluginUiFactory,
  PluginUiProject,
  PluginUiRegistration,
} from "@t3tools/plugin-api/ui";
import * as React from "react";
import { useEffect, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import type { WsRpcClient } from "@t3tools/client-runtime";

import { toastManager } from "../components/ui/toast";
import { usePrimaryEnvironmentId } from "../environments/primary";
import { readLocalApi } from "../localApi";
import { selectProjectsAcrossEnvironments, useStore } from "../store";
import type { PluginCatalogManifestEntry } from "./pluginCatalogEntry";
import { createPluginUiComponents } from "./pluginUiComponents";

export type DynamicPluginNavigate = (options: { readonly to: string }) => unknown;

type PluginContextBase = PluginUiBaseContext;
type PluginApiCacheKey = `${string}:${string}`;
export interface PluginUiRpcClient {
  readonly plugins: Pick<WsRpcClient["plugins"], "invoke" | "subscribe">;
}

type PluginUiRegistrationState =
  | { readonly cacheKey: string; readonly status: "loading" }
  | {
      readonly cacheKey: string;
      readonly status: "ready";
      readonly registration: PluginUiRegistration;
    }
  | { readonly cacheKey: string; readonly status: "failed"; readonly message: string };

const pluginUiRegistrationByKey = new Map<string, PluginUiRegistrationState>();
const pluginApiByKey = new Map<PluginApiCacheKey, PluginUiBaseContext["api"]>();

export class PluginUiErrorBoundary extends React.Component<
  {
    readonly resetKey: string;
    readonly renderError: (error: Error) => React.ReactNode;
    readonly onError?: (error: Error) => void;
    readonly children: React.ReactNode;
  },
  { readonly error: Error | null; readonly resetKey: string }
> {
  override state: { readonly error: Error | null; readonly resetKey: string } = {
    error: null,
    resetKey: this.props.resetKey,
  };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  static getDerivedStateFromProps(
    props: { readonly resetKey: string },
    state: { readonly resetKey: string },
  ) {
    if (props.resetKey !== state.resetKey) {
      return { error: null, resetKey: props.resetKey };
    }
    return null;
  }

  override componentDidCatch(error: Error) {
    this.props.onError?.(error);
  }

  override render() {
    return this.state.error === null
      ? this.props.children
      : this.props.renderError(this.state.error);
  }
}

function loadingRegistrationState(cacheKey: string): PluginUiRegistrationState {
  return { cacheKey, status: "loading" };
}

function usePluginProjects(): ReadonlyArray<PluginUiProject> {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));

  return useMemo(
    () =>
      projects
        .filter(
          (project) =>
            primaryEnvironmentId === null || project.environmentId === primaryEnvironmentId,
        )
        .sort((first, second) => first.name.localeCompare(second.name))
        .map((project) => ({
          id: project.id,
          name: project.name,
          environmentId: project.environmentId,
        })),
    [primaryEnvironmentId, projects],
  );
}

function pluginThreadHref(input: {
  readonly environmentId: string;
  readonly threadId: string;
}): string {
  return `/${encodeURIComponent(input.environmentId)}/${encodeURIComponent(input.threadId)}`;
}

async function confirmPluginAction(message: string): Promise<boolean> {
  return (await readLocalApi()?.dialogs.confirm(message)) ?? window.confirm(message);
}

export function removePluginUiRegistrationsForScope(hostScope: string) {
  const keyPrefix = `${hostScope}\u0000`;
  for (const cacheKey of pluginUiRegistrationByKey.keys()) {
    if (cacheKey.startsWith(keyPrefix)) {
      pluginUiRegistrationByKey.delete(cacheKey);
    }
  }
  for (const apiKey of pluginApiByKey.keys()) {
    if (apiKey.startsWith(keyPrefix)) {
      pluginApiByKey.delete(apiKey);
    }
  }
}

export function removePluginUiRegistrationsForAssetKeys(assetKeys: Iterable<string>) {
  const keys = new Set(assetKeys);
  if (keys.size === 0) return;

  for (const cacheKey of keys) {
    pluginUiRegistrationByKey.delete(cacheKey);
  }
  for (const apiKey of pluginApiByKey.keys()) {
    for (const cacheKey of keys) {
      if (apiKey.startsWith(`${cacheKey}:`)) {
        pluginApiByKey.delete(apiKey);
        break;
      }
    }
  }
}

function pluginApiCacheKey(input: {
  readonly cacheKey: string;
  readonly client: PluginUiRpcClient;
  readonly catalogEntry: PluginCatalogManifestEntry;
}): PluginApiCacheKey {
  return `${input.cacheKey}:${input.catalogEntry.manifest.id}` as PluginApiCacheKey;
}

function getPluginApi(input: {
  readonly cacheKey: string;
  readonly client: PluginUiRpcClient;
  readonly catalogEntry: PluginCatalogManifestEntry;
}) {
  const pluginId = input.catalogEntry.manifest.id;
  const cacheKey = pluginApiCacheKey(input);
  const existing = pluginApiByKey.get(cacheKey);
  if (existing) {
    return existing;
  }
  const api: PluginUiBaseContext["api"] = {
    invoke: async <O,>(command: PluginCommandName | string, commandInput: unknown) => {
      const result = await input.client.plugins.invoke({
        pluginId,
        command: PluginCommandName.make(String(command)),
        input: commandInput,
      });
      return result.output as O;
    },
    subscribe: (callback, options) =>
      input.client.plugins.subscribe({ pluginId }, callback, options),
  };
  pluginApiByKey.set(cacheKey, api);
  return api;
}

export function createPluginContextBase(input: {
  readonly cacheKey: string;
  readonly client: PluginUiRpcClient;
  readonly catalogEntry: PluginCatalogManifestEntry;
  readonly navigate: DynamicPluginNavigate;
}): PluginContextBase {
  const pluginId = input.catalogEntry.manifest.id;

  return {
    pluginId,
    catalogEntry: input.catalogEntry,
    uiApiVersion: 1,
    react: React,
    api: getPluginApi(input),
    host: {
      useProjects: usePluginProjects,
      confirm: confirmPluginAction,
      threadHref: pluginThreadHref,
    },
    navigation: {
      navigate: (to) => {
        void input.navigate({ to });
      },
    },
    toast: {
      success: (title, description) => {
        toastManager.add({ type: "success", title, description });
      },
      error: (title, description) => {
        toastManager.add({ type: "error", title, description });
      },
    },
  };
}

export function createPluginRouteContext(input: {
  readonly baseContext: PluginContextBase;
  readonly routeId: PluginRouteId;
  readonly routeSurface: PluginRouteSurface;
}): PluginUiContext {
  return {
    ...input.baseContext,
    route: {
      id: input.routeId,
      surface: input.routeSurface,
    },
    components: createPluginUiComponents(input.routeSurface),
  };
}

export function createPluginComposerActionContext(input: {
  readonly baseContext: PluginContextBase;
  readonly action: PluginComposerActionContribution;
  readonly composer: Omit<PluginComposerApi, "setActionState">;
  readonly setActionState: (state: ComposerPluginActionState) => void;
}): PluginComposerActionContext {
  return {
    ...input.baseContext,
    composerAction: {
      id: input.action.id,
      position: input.action.position,
    },
    composer: {
      ...input.composer,
      setActionState: input.setActionState,
    },
    components: createPluginUiComponents("app"),
  };
}

export function usePluginUiRegistration(input: {
  readonly cacheKey: string;
  readonly factory: PluginUiFactory;
}): PluginUiRegistrationState {
  const [state, setState] = React.useState<PluginUiRegistrationState>(
    () => pluginUiRegistrationByKey.get(input.cacheKey) ?? loadingRegistrationState(input.cacheKey),
  );

  useEffect(() => {
    let active = true;
    const cached = pluginUiRegistrationByKey.get(input.cacheKey);
    if (cached) {
      setState(cached);
      return () => {
        active = false;
      };
    }
    setState(loadingRegistrationState(input.cacheKey));
    try {
      const registration = input.factory();
      const readyState: PluginUiRegistrationState = {
        cacheKey: input.cacheKey,
        status: "ready",
        registration,
      };
      pluginUiRegistrationByKey.set(input.cacheKey, readyState);
      if (active) {
        setState(readyState);
      }
    } catch (error) {
      const failedState: PluginUiRegistrationState = {
        cacheKey: input.cacheKey,
        status: "failed",
        message: error instanceof Error ? error.message : "Plugin UI registration failed.",
      };
      pluginUiRegistrationByKey.set(input.cacheKey, failedState);
      if (active) {
        setState(failedState);
      }
    }
    return () => {
      active = false;
    };
  }, [input.cacheKey, input.factory]);

  return state.cacheKey === input.cacheKey ? state : loadingRegistrationState(input.cacheKey);
}
