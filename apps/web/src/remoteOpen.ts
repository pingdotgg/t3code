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
import { useEffect, useState } from "react";

import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { isLoopbackHostname } from "~/environments/primary/target";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { environmentPresentations } from "~/state/presentation";

export interface RemoteOpenHost {
  readonly kind: "ssh-alias" | RemoteOpenTarget["kind"];
  readonly host: string;
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
  readonly sshAlias: string | null;
  readonly remoteOpenTargets: ReadonlyArray<RemoteOpenTarget> | undefined;
  readonly isDesktopRenderer: boolean;
}): RemoteOpenState {
  const { target } = input;
  if (target === null) {
    return LOCAL_EXEC;
  }
  if (target._tag === "PrimaryConnectionTarget") {
    // The desktop app manages its own primary backend, so it is always on this machine even
    // when its URL is not loopback (wsl-only mode binds the WSL2 NAT address).
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

  if (input.sshAlias !== null && input.sshAlias.length > 0) {
    return { mode: "remote-links", host: { kind: "ssh-alias", host: input.sshAlias } };
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
  return previous.host.kind === next.host.kind && previous.host.host === next.host.host;
}

// The presentation changes with every server config push and reconnect. This
// keeps the previous resolution while it is equal, so subscribers re-render only
// when where files open actually changes.
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
        sshAlias:
          profile !== null && profile._tag === "SshConnectionProfile" ? profile.target.alias : null,
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

let cachedProbedEditors: ReadonlyArray<EditorId> | null = null;

export function useRemoteCapableEditors(): ReadonlyArray<EditorId> {
  const [editors, setEditors] = useState<ReadonlyArray<EditorId>>(
    () => cachedProbedEditors ?? REMOTE_FALLBACK_EDITORS,
  );

  useEffect(() => {
    if (cachedProbedEditors !== null) {
      return;
    }
    const probe = window.desktopBridge?.probeRemoteEditors;
    if (probe === undefined) {
      cachedProbedEditors = REMOTE_FALLBACK_EDITORS;
      return;
    }
    let cancelled = false;
    probe().then(
      (ids) => {
        const remoteCapable = ids.filter((id) => REMOTE_CAPABLE_EDITOR_IDS.includes(id));
        cachedProbedEditors = remoteCapable.length > 0 ? remoteCapable : REMOTE_FALLBACK_EDITORS;
        if (!cancelled) {
          setEditors(cachedProbedEditors);
        }
      },
      () => {
        cachedProbedEditors = REMOTE_FALLBACK_EDITORS;
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return editors;
}

/**
 * Resolves false when the desktop shell refused the URL (e.g. an older build whose protocol
 * allowlist predates editor schemes) so callers do not record a successful open that never
 * happened.
 */
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
