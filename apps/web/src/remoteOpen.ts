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

import { browserClientOs, type BrowserIdentity } from "~/connection/clientMetadata";
import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { isLoopbackHostname } from "~/environments/primary/target";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { environmentPresentations } from "~/state/presentation";

export interface RemoteOpenHost {
  readonly kind: "ssh-alias" | RemoteOpenTarget["kind"];
  readonly host: string;
  readonly username?: string;
}

export type RemoteOpenState =
  | { readonly mode: "local-exec" }
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

export function useRemoteOpenResolution(environmentId: EnvironmentId | null): RemoteOpenResolution {
  return useAtomValue(
    environmentId === null ? UNRESOLVED_REMOTE_OPEN_ATOM : remoteOpenResolutionAtom(environmentId),
  );
}

export function useRemoteOpenState(environmentId: EnvironmentId | null): RemoteOpenState {
  return useRemoteOpenResolution(environmentId).state;
}

const REMOTE_FALLBACK_EDITORS: ReadonlyArray<EditorId> = ["vscode"];

// Phone and tablet browsers have no desktop editor to receive a vscode:// remote link.
export function remoteFallbackEditors(identity: BrowserIdentity): ReadonlyArray<EditorId> {
  const os = browserClientOs(identity);
  return os === "iOS" || os === "Android" ? [] : REMOTE_FALLBACK_EDITORS;
}

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
  return remoteFallbackEditors(navigator);
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

const REMOTE_OPEN_HINT_KEY = "t3code:remote-open-hint-seen";

export function useRemoteOpenHint(): readonly [seen: boolean, markSeen: () => void] {
  const [seen, setSeen] = useLocalStorage(REMOTE_OPEN_HINT_KEY, false, Schema.Boolean);
  return [seen, () => setSeen(true)] as const;
}
