import { useAtomSubscribe, useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_SERVER_SETTINGS,
  type EditorId,
  type ResolvedKeybindingsConfig,
  type ServerConfig,
  type ServerLifecycleWelcomePayload,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { useEffect } from "react";

import { readNativeApi } from "./nativeApi";
import {
  serverConfigAtom,
  serverConfigUpdatedAtom,
  type ServerConfigUpdatedNotification,
  wsWelcomeAtom,
} from "./wsNativeApiState";

const EMPTY_AVAILABLE_EDITORS: ReadonlyArray<EditorId> = [];
const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];
const EMPTY_SERVER_PROVIDERS: ReadonlyArray<ServerProvider> = [];

const selectAvailableEditors = (config: ServerConfig | null): ReadonlyArray<EditorId> =>
  config?.availableEditors ?? EMPTY_AVAILABLE_EDITORS;
const selectKeybindings = (config: ServerConfig | null) => config?.keybindings ?? EMPTY_KEYBINDINGS;
const selectKeybindingsConfigPath = (config: ServerConfig | null) =>
  config?.keybindingsConfigPath ?? null;
const selectProviders = (config: ServerConfig | null) =>
  config?.providers ?? EMPTY_SERVER_PROVIDERS;
const selectSettings = (config: ServerConfig | null): ServerSettings =>
  config?.settings ?? DEFAULT_SERVER_SETTINGS;

function useLatestAtomSubscription<A>(
  atom: import("effect/unstable/reactivity/Atom").Atom<A | null>,
  listener: (value: NonNullable<A>) => void,
) {
  useAtomSubscribe(
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

export function WsNativeApiAtomsBootstrap() {
  const serverConfig = useServerConfig();

  useEffect(() => {
    if (serverConfig !== null) {
      return;
    }

    const api = readNativeApi();
    if (!api) {
      return;
    }

    void api.server.getConfig().catch(() => undefined);
  }, [serverConfig]);

  return null;
}

export function useServerConfig(): ServerConfig | null {
  return useAtomValue(serverConfigAtom);
}

export function useServerSettings(): ServerSettings {
  return useAtomValue(serverConfigAtom, selectSettings);
}

export function useServerProviders(): ReadonlyArray<ServerProvider> {
  return useAtomValue(serverConfigAtom, selectProviders);
}

export function useServerKeybindings(): ResolvedKeybindingsConfig {
  return useAtomValue(serverConfigAtom, selectKeybindings);
}

export function useServerAvailableEditors(): ReadonlyArray<EditorId> {
  return useAtomValue(serverConfigAtom, selectAvailableEditors);
}

export function useServerKeybindingsConfigPath(): string | null {
  return useAtomValue(serverConfigAtom, selectKeybindingsConfigPath);
}

export function useServerWelcomeSubscription(
  listener: (payload: ServerLifecycleWelcomePayload) => void,
): void {
  useLatestAtomSubscription(wsWelcomeAtom, listener);
}

export function useServerConfigUpdatedSubscription(
  listener: (notification: ServerConfigUpdatedNotification) => void,
): void {
  useLatestAtomSubscription(serverConfigUpdatedAtom, listener);
}
