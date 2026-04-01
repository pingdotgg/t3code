import {
  type ServerConfig,
  type ServerConfigStreamEvent,
  type ServerConfigUpdatedPayload,
  type ServerLifecycleWelcomePayload,
  type ServerProviderUpdatedPayload,
  type ServerSettings,
} from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry, resetAppAtomRegistryForTests } from "./rpc/atomRegistry";

export type ServerConfigUpdateSource = ServerConfigStreamEvent["type"];

export interface ServerConfigUpdatedNotification {
  readonly payload: ServerConfigUpdatedPayload;
  readonly source: ServerConfigUpdateSource;
}

function makeStateAtom<A>(label: string, initialValue: A) {
  return Atom.make(initialValue).pipe(Atom.keepAlive, Atom.withLabel(label));
}

function toServerConfigUpdatedPayload(config: ServerConfig): ServerConfigUpdatedPayload {
  return {
    issues: config.issues,
    providers: config.providers,
    settings: config.settings,
  };
}

export const wsWelcomeAtom = makeStateAtom<ServerLifecycleWelcomePayload | null>(
  "ws-server-welcome",
  null,
);
export const serverConfigAtom = makeStateAtom<ServerConfig | null>("ws-server-config", null);
export const serverConfigUpdatedAtom = makeStateAtom<ServerConfigUpdatedNotification | null>(
  "ws-server-config-updated",
  null,
);
export const providersUpdatedAtom = makeStateAtom<ServerProviderUpdatedPayload | null>(
  "ws-server-providers-updated",
  null,
);

export function getServerConfig(): ServerConfig | null {
  return appAtomRegistry.get(serverConfigAtom);
}

export function setServerConfigSnapshot(config: ServerConfig): void {
  resolveServerConfig(config);
  emitProvidersUpdated({ providers: config.providers });
  emitServerConfigUpdated(toServerConfigUpdatedPayload(config), "snapshot");
}

export function applyServerConfigEvent(event: ServerConfigStreamEvent): void {
  switch (event.type) {
    case "snapshot": {
      setServerConfigSnapshot(event.config);
      return;
    }
    case "keybindingsUpdated": {
      const latestServerConfig = getServerConfig();
      if (!latestServerConfig) {
        return;
      }
      const nextConfig = {
        ...latestServerConfig,
        issues: event.payload.issues,
      } satisfies ServerConfig;
      resolveServerConfig(nextConfig);
      emitServerConfigUpdated(toServerConfigUpdatedPayload(nextConfig), event.type);
      return;
    }
    case "providerStatuses": {
      applyProvidersUpdated(event.payload);
      return;
    }
    case "settingsUpdated": {
      applySettingsUpdated(event.payload.settings);
      return;
    }
  }
}

export function applyProvidersUpdated(payload: ServerProviderUpdatedPayload): void {
  const latestServerConfig = getServerConfig();
  emitProvidersUpdated(payload);

  if (!latestServerConfig) {
    return;
  }

  const nextConfig = {
    ...latestServerConfig,
    providers: payload.providers,
  } satisfies ServerConfig;
  resolveServerConfig(nextConfig);
  emitServerConfigUpdated(toServerConfigUpdatedPayload(nextConfig), "providerStatuses");
}

export function applySettingsUpdated(settings: ServerSettings): void {
  const latestServerConfig = getServerConfig();
  if (!latestServerConfig) {
    return;
  }

  const nextConfig = {
    ...latestServerConfig,
    settings,
  } satisfies ServerConfig;
  resolveServerConfig(nextConfig);
  emitServerConfigUpdated(toServerConfigUpdatedPayload(nextConfig), "settingsUpdated");
}

export function emitWelcome(payload: ServerLifecycleWelcomePayload): void {
  appAtomRegistry.set(wsWelcomeAtom, payload);
}

export function onWelcome(listener: (payload: ServerLifecycleWelcomePayload) => void): () => void {
  return subscribeLatest(wsWelcomeAtom, listener);
}

export function onServerConfigUpdated(
  listener: (payload: ServerConfigUpdatedPayload, source: ServerConfigUpdateSource) => void,
): () => void {
  return subscribeLatest(serverConfigUpdatedAtom, (notification) => {
    listener(notification.payload, notification.source);
  });
}

export function onProvidersUpdated(
  listener: (payload: ServerProviderUpdatedPayload) => void,
): () => void {
  return subscribeLatest(providersUpdatedAtom, listener);
}

export function resetWsNativeApiStateForTests() {
  resetAppAtomRegistryForTests();
}

function resolveServerConfig(config: ServerConfig): void {
  appAtomRegistry.set(serverConfigAtom, config);
}

function emitProvidersUpdated(payload: ServerProviderUpdatedPayload): void {
  appAtomRegistry.set(providersUpdatedAtom, payload);
}

function emitServerConfigUpdated(
  payload: ServerConfigUpdatedPayload,
  source: ServerConfigUpdateSource,
): void {
  appAtomRegistry.set(serverConfigUpdatedAtom, { payload, source });
}

function subscribeLatest<A>(
  atom: Atom.Atom<A | null>,
  listener: (value: NonNullable<A>) => void,
): () => void {
  return appAtomRegistry.subscribe(
    atom,
    (value) => {
      if (value === null) {
        return;
      }
      listener(value as NonNullable<A>);
    },
    { immediate: true },
  );
}
