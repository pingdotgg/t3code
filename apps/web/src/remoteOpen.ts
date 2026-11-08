import type { ConnectionTarget } from "@t3tools/client-runtime/connection";
import {
  REMOTE_CAPABLE_EDITOR_IDS,
  type EditorId,
  type EnvironmentId,
  type RemoteOpenTarget,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";
import { useAtomValue } from "@effect/atom-react";

import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { isLoopbackHostname } from "~/environments/primary/target";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { environmentPresentations } from "~/state/presentation";
import { environmentSession } from "~/state/session";
import { toastManager } from "~/components/ui/toast";

export interface RemoteOpenHost {
  readonly kind: "ssh-alias" | RemoteOpenTarget["kind"];
  readonly host: string;
  readonly username?: string;
}

export type RemoteOpenState =
  | { readonly mode: "local-exec" }
  | { readonly mode: "device-local" }
  | { readonly mode: "remote-links"; readonly host: RemoteOpenHost }
  | { readonly mode: "remote-unavailable" };

export type RemoteOpenMode = RemoteOpenState["mode"];

export interface RemoteOpenResolution {
  readonly state: RemoteOpenState;
  readonly isResolved: boolean;
}

const LOCAL_EXEC: RemoteOpenState = { mode: "local-exec" };
const REMOTE_UNAVAILABLE: RemoteOpenState = { mode: "remote-unavailable" };
const UNRESOLVED_REMOTE_OPEN: RemoteOpenResolution = {
  state: LOCAL_EXEC,
  isResolved: false,
};

function parseHostname(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export function resolveRemoteOpenState(input: {
  readonly target: ConnectionTarget | null;
  readonly sshTarget: { readonly alias: string; readonly username: string | null } | null;
  readonly remoteOpenTargets: ReadonlyArray<RemoteOpenTarget> | undefined;
  readonly isDesktopRenderer: boolean;
  readonly openOnThisDevice?: boolean;
}): RemoteOpenState {
  const { target } = input;
  if (target === null) {
    return LOCAL_EXEC;
  }
  if (target._tag === "PrimaryConnectionTarget") {
    // Desktop owns its primary even at a non-loopback WSL2 NAT address.
    if (input.isDesktopRenderer) {
      return LOCAL_EXEC;
    }
    const hostname = parseHostname(target.httpBaseUrl);
    if (hostname !== null && isLoopbackHostname(hostname)) {
      return LOCAL_EXEC;
    }
  } else if (isDesktopLocalConnectionTarget(target)) {
    return LOCAL_EXEC;
  }

  if (input.sshTarget !== null && input.sshTarget.alias.length > 0) {
    const { alias } = input.sshTarget;
    const userSeparator = alias.lastIndexOf("@");
    const host = userSeparator === -1 ? alias : alias.slice(userSeparator + 1);
    const username =
      input.sshTarget.username?.trim() ||
      (userSeparator === -1 ? null : alias.slice(0, userSeparator));
    return {
      mode: "remote-links",
      host: {
        kind: "ssh-alias",
        host,
        ...(username === null ? {} : { username }),
      },
    };
  }
  if (input.isDesktopRenderer && input.openOnThisDevice && deviceLocalRouteKey(target) !== null) {
    return { mode: "device-local" };
  }
  const advertised = input.remoteOpenTargets?.[0];
  if (advertised !== undefined) {
    return { mode: "remote-links", host: advertised };
  }
  return REMOTE_UNAVAILABLE;
}

function remoteOpenStatesEqual(previous: RemoteOpenState, next: RemoteOpenState): boolean {
  if (previous.mode !== next.mode) return false;
  if (previous.mode !== "remote-links" || next.mode !== "remote-links") return true;
  return (
    previous.host.kind === next.host.kind &&
    previous.host.host === next.host.host &&
    previous.host.username === next.host.username
  );
}

// Config pushes recreate presentations; preserve equal resolutions to avoid re-rendering file links.
const remoteOpenResolutionAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): RemoteOpenResolution => {
    const presentation = get(environmentPresentations.presentationAtom(environmentId));
    const entry = presentation?.entry ?? null;
    if (entry === null) {
      return UNRESOLVED_REMOTE_OPEN;
    }
    const profile = Option.getOrNull(entry.profile);
    const next: RemoteOpenResolution = {
      state: resolveRemoteOpenState({
        target: entry.target,
        sshTarget:
          profile !== null && profile._tag === "SshConnectionProfile" ? profile.target : null,
        remoteOpenTargets: presentation?.serverConfig?.remoteOpenTargets,
        isDesktopRenderer: window.desktopBridge !== undefined,
      }),
      isResolved: true,
    };
    const previous = Option.getOrNull(get.self<RemoteOpenResolution>());
    return previous !== null &&
      previous.isResolved &&
      remoteOpenStatesEqual(previous.state, next.state)
      ? previous
      : next;
  }).pipe(Atom.withLabel(`remote-open-resolution:${environmentId}`)),
);

const UNRESOLVED_REMOTE_OPEN_ATOM = Atom.make(UNRESOLVED_REMOTE_OPEN);

const DEVICE_LOCAL_ROUTES_KEY = "t3code:device-local-editor-routes:v1";
const DeviceLocalRoutes = Schema.Array(Schema.String);

export function deviceLocalRouteKey(target: ConnectionTarget): string | null {
  if (target._tag === "RelayConnectionTarget") {
    return JSON.stringify([target.environmentId, target._tag]);
  }
  if (target._tag !== "BearerConnectionTarget" || target.connectionId.startsWith("local:"))
    return null;
  return JSON.stringify([target.environmentId, target._tag, target.connectionId]);
}

export function deviceLocalPreferenceKey(
  clientId: string | null,
  target: ConnectionTarget | undefined,
): string | null {
  const routeKey = target === undefined ? null : deviceLocalRouteKey(target);
  return clientId === null || routeKey === null ? null : JSON.stringify([clientId, routeKey]);
}

export function withDeviceLocalRoute(routes: readonly string[], key: string, enabled: boolean) {
  return enabled
    ? routes.includes(key)
      ? routes
      : [...routes, key]
    : routes.filter((r) => r !== key);
}

const NO_PREPARED_CONNECTION = Atom.make(
  Option.none<import("@t3tools/client-runtime/connection").PreparedConnection>(),
);

let editorClientId: string | null | undefined;

// Identity lives outside Chromium storage, so importing storage cannot authorize another install.
// The lookup is a synchronous IPC round trip, so it runs once per page.
function readEditorClientId(): string | null {
  if (editorClientId === undefined) {
    try {
      editorClientId = window.desktopBridge?.getEditorClientId?.() ?? null;
    } catch {
      editorClientId = null;
    }
  }
  return editorClientId;
}

export function useDeviceLocalEditorPreference(environmentId: EnvironmentId | null) {
  const prepared = useAtomValue(
    environmentId === null
      ? NO_PREPARED_CONNECTION
      : environmentSession.preparedConnectionValueAtom(environmentId),
  );
  const target = Option.getOrNull(prepared)?.target;
  const key = deviceLocalPreferenceKey(readEditorClientId(), target);
  const [routes, setRoutes] = useLocalStorage<readonly string[], readonly string[]>(
    DEVICE_LOCAL_ROUTES_KEY,
    [],
    DeviceLocalRoutes,
  );
  return {
    available: key !== null && window.desktopBridge?.openLocalEditor !== undefined,
    enabled:
      key !== null && window.desktopBridge?.openLocalEditor !== undefined && routes.includes(key),
    setEnabled: (enabled: boolean) => {
      if (key !== null) setRoutes((previous) => withDeviceLocalRoute(previous, key, enabled));
    },
  };
}

export function useRemoteOpenResolution(environmentId: EnvironmentId | null): RemoteOpenResolution {
  const resolution = useAtomValue(
    environmentId === null ? UNRESOLVED_REMOTE_OPEN_ATOM : remoteOpenResolutionAtom(environmentId),
  );
  const preference = useDeviceLocalEditorPreference(environmentId);
  return preference.enabled
    ? { state: { mode: "device-local" }, isResolved: resolution.isResolved }
    : resolution;
}

export function useRemoteOpenState(environmentId: EnvironmentId | null): RemoteOpenState {
  return useRemoteOpenResolution(environmentId).state;
}

const REMOTE_FALLBACK_EDITORS: ReadonlyArray<EditorId> = ["vscode"];

// Probed once per page: installed editors rarely change, and the probe spawns processes.
const remoteCapableEditorsAtom = Atom.make((get): ReadonlyArray<EditorId> => {
  const probe = window.desktopBridge?.probeRemoteEditors;
  probe?.().then(
    (ids) => {
      const remoteCapable = ids.filter((id) => REMOTE_CAPABLE_EDITOR_IDS.includes(id));
      if (remoteCapable.length > 0) get.setSelf(remoteCapable);
    },
    () => undefined,
  );
  return REMOTE_FALLBACK_EDITORS;
}).pipe(Atom.keepAlive, Atom.withLabel("remote-capable-editors"));

export function useRemoteCapableEditors(): ReadonlyArray<EditorId> {
  return useAtomValue(remoteCapableEditorsAtom);
}

/** Resolves false when the desktop refuses the URL, including unsupported editor schemes. */
export async function openRemoteEditorUrl(url: string): Promise<boolean> {
  const bridge = window.desktopBridge;
  if (bridge !== undefined) {
    try {
      return await bridge.openExternal(url);
    } catch {
      return false;
    }
  }
  window.location.assign(url);
  return true;
}

export async function openDeviceLocalEditor(editor: EditorId, path: string): Promise<boolean> {
  try {
    const result = await window.desktopBridge?.openLocalEditor?.({ editor, path });
    if (result?.ok) return true;
    toastManager.add({
      type: "error",
      title: "Could not open editor on this device",
      description:
        result?.reason === "path-missing"
          ? `Path does not exist on this device: ${path}. Local paths must match the environment.`
          : `Local editor opening failed (${result?.reason ?? "desktop bridge unavailable"}). No server-side fallback was attempted.`,
    });
  } catch {
    toastManager.add({ type: "error", title: "Could not open editor on this device" });
  }
  return false;
}

const REMOTE_OPEN_HINT_KEY = "t3code:remote-open-hint-seen";

export function useRemoteOpenHint(): readonly [seen: boolean, markSeen: () => void] {
  const [seen, setSeen] = useLocalStorage(REMOTE_OPEN_HINT_KEY, false, Schema.Boolean);
  return [seen, () => setSeen(true)] as const;
}
