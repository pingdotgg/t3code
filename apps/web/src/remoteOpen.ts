/**
 * Editor opening uses a local WSL deep link when explicitly configured on
 * Windows. Otherwise, remote clients use an SSH deep link instead of executing
 * an editor on the environment host.
 *
 * Host precedence: a desktop-SSH environment's real `~/.ssh/config` alias
 * beats server-advertised names; among advertised names the tailnet MagicDNS
 * name beats mDNS `<hostname>.local` (server sends them in that order).
 */
import type { ConnectionTarget } from "@t3tools/client-runtime/connection";
import {
  REMOTE_CAPABLE_EDITOR_IDS,
  isWslDistroName,
  type EditorId,
  type EnvironmentId,
  type RemoteOpenTarget,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useEffect, useMemo, useState } from "react";

import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { isLoopbackHostname } from "~/environments/primary/target";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { isWindowsPlatform } from "~/lib/utils";
import { useLocalWslEditor } from "~/localWslEditor";
import { useEnvironmentPresentation } from "~/state/presentation";

export interface RemoteOpenHost {
  readonly kind: "ssh-alias" | "wsl" | RemoteOpenTarget["kind"];
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

/** Extracts a hostname without treating malformed environment URLs as local endpoints. */
function parseHostname(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * Selects local execution or a client-side editor link. A valid Windows WSL
 * override wins; Automatic uses local execution, an SSH alias, or the first
 * advertised host, and disables opening when no remote route is available.
 */
export function resolveRemoteOpenState(input: {
  readonly target: ConnectionTarget | null;
  /** Real ssh alias for desktop-SSH environments; null elsewhere. */
  readonly sshAlias: string | null;
  /** Server-advertised hosts; undefined on servers that predate the feature. */
  readonly remoteOpenTargets: ReadonlyArray<RemoteOpenTarget> | undefined;
  /** True when running inside the desktop app's renderer. */
  readonly isDesktopRenderer: boolean;
  readonly isWindowsClient?: boolean;
  readonly localWslDistro?: string | null;
}): RemoteOpenState {
  if (
    input.isWindowsClient &&
    input.localWslDistro !== undefined &&
    input.localWslDistro !== null &&
    isWslDistroName(input.localWslDistro)
  ) {
    return { mode: "remote-links", host: { kind: "wsl", host: input.localWslDistro } };
  }
  const { target } = input;
  // No catalog entry: keep today's exec behavior rather than guessing.
  if (target === null) {
    return LOCAL_EXEC;
  }
  if (target._tag === "PrimaryConnectionTarget") {
    // The desktop app manages its own primary backend, so it is always on
    // this machine even when its URL is not loopback (wsl-only mode binds
    // the WSL2 NAT address). In a browser, a loopback primary means the
    // browser runs on the serving machine; a tailnet/LAN URL means remote.
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

/**
 * Combines environment connection details with this device's WSL preference.
 * isResolved distinguishes missing presentation data from a resolved route.
 */
export function useRemoteOpenResolution(environmentId: EnvironmentId | null): RemoteOpenResolution {
  const { presentation } = useEnvironmentPresentation(environmentId);
  const [localWsl] = useLocalWslEditor(environmentId);

  return useMemo(() => {
    if (presentation === null) {
      return UNRESOLVED_REMOTE_OPEN;
    }
    const profile = Option.getOrNull(presentation.entry.profile);
    const sshAlias =
      profile !== null && profile._tag === "SshConnectionProfile" ? profile.target.alias : null;
    return {
      state: resolveRemoteOpenState({
        target: presentation.entry.target,
        sshAlias,
        remoteOpenTargets: presentation.serverConfig?.remoteOpenTargets,
        isDesktopRenderer: window.desktopBridge !== undefined,
        isWindowsClient: isWindowsPlatform(navigator.platform),
        localWslDistro: localWsl?.distro ?? null,
      }),
      isResolved: true,
    };
  }, [presentation, localWsl]);
}

/** Returns the environment's effective editor route, including this device's WSL override. */
export function useRemoteOpenState(environmentId: EnvironmentId | null): RemoteOpenState {
  return useRemoteOpenResolution(environmentId).state;
}

const REMOTE_FALLBACK_EDITORS: ReadonlyArray<EditorId> = ["vscode"];

let cachedProbedEditors: ReadonlyArray<EditorId> | null = null;

/**
 * Offers editors installed on the viewing desktop. Browsers cannot probe
 * installed editors, so they offer VS Code for remote links.
 */
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
 * Fire a remote editor deep link. In desktop, route through the Electron
 * shell so the OS handler opens without navigating the renderer; in a
 * browser, assign the location — unlike window.open this does not leave a
 * blank tab behind.
 *
 * Resolves false when the desktop shell refused the URL (e.g. an older
 * build whose protocol allowlist predates editor schemes) so callers do not
 * record a successful open that never happened.
 */
export async function openRemoteEditorUrl(url: string): Promise<boolean> {
  const bridge = window.desktopBridge;
  try {
    if (bridge !== undefined) {
      return await bridge.openExternal(url);
    }
    window.location.assign(url);
    return true;
  } catch {
    return false;
  }
}

const REMOTE_OPEN_HINT_KEY = "t3code:remote-open-hint-seen";

/** Remembers an accepted SSH handoff on this device so its setup hint stops appearing. */
export function useRemoteOpenHint(): readonly [seen: boolean, markSeen: () => void] {
  const [seen, setSeen] = useLocalStorage(REMOTE_OPEN_HINT_KEY, false, Schema.Boolean);
  return [seen, () => setSeen(true)] as const;
}
