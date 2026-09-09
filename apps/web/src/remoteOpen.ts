/**
 * Remote open-in-editor: when this client is not on the environment's
 * machine, "Open" must hand the OS a `vscode://vscode-remote/ssh-remote+…`
 * deep link (local editor connects over SSH) instead of exec'ing an editor
 * on the environment host.
 *
 * Host precedence: a desktop-SSH environment's real `~/.ssh/config` alias
 * beats server-advertised names; among advertised names the tailnet MagicDNS
 * name beats mDNS `<hostname>.local` (server sends them in that order).
 */
import type { ConnectionTarget } from "@t3tools/client-runtime/connection";
import { connectionCatalogDisplayUrl } from "@t3tools/client-runtime/connection";
import {
  REMOTE_CAPABLE_EDITOR_IDS,
  type DesktopEnvironmentBootstrap,
  type EditorId,
  type EnvironmentId,
  type RemoteOpenTarget,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useEffect, useMemo, useState } from "react";

import { desktopLocalBackendId, isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import {
  useDesktopLocalBootstraps,
  useDesktopPrimaryWslDistro,
} from "~/connection/useDesktopLocalBootstraps";
import { isLoopbackHostname } from "~/environments/primary/target";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useEnvironmentPresentation } from "~/state/presentation";

export interface RemoteOpenHost {
  readonly kind: "ssh-alias" | "wsl" | RemoteOpenTarget["kind"];
  /** SSH host name, or the WSL distro name for `kind: "wsl"`. */
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

const wslLinks = (distro: string): RemoteOpenState => ({
  mode: "remote-links",
  host: { kind: "wsl", host: distro },
});

/**
 * Whether the environment's server can run shell actions (open in editor, reveal in file
 * manager) on the user's machine. True for local exec and for WSL, where the server runs inside
 * the distro on the same machine and only editor links are routed through the Windows host.
 */
export function canExecOnServer(state: RemoteOpenState): boolean {
  return (
    state.mode === "local-exec" || (state.mode === "remote-links" && state.host.kind === "wsl")
  );
}

function parseHostname(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export function resolveRemoteOpenState(input: {
  readonly target: ConnectionTarget | null;
  /** Real ssh alias for desktop-SSH environments; null elsewhere. */
  readonly sshAlias: string | null;
  /** Server-advertised hosts; undefined on servers that predate the feature. */
  readonly remoteOpenTargets: ReadonlyArray<RemoteOpenTarget> | undefined;
  /** True when running inside the desktop app's renderer. */
  readonly isDesktopRenderer: boolean;
  /**
   * Running distro when the environment's server lives inside WSL on this
   * machine: a desktop-local WSL backend, or the primary in wsl-only mode.
   * Null when unknown or not WSL.
   */
  readonly wslDistro?: string | null;
}): RemoteOpenState {
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
      return input.wslDistro ? wslLinks(input.wslDistro) : LOCAL_EXEC;
    }
    const hostname = parseHostname(target.httpBaseUrl);
    if (hostname !== null && isLoopbackHostname(hostname)) {
      return LOCAL_EXEC;
    }
  } else if (isDesktopLocalConnectionTarget(target)) {
    // A WSL backend runs on this machine, but its Linux PATH rarely carries
    // the Windows editors. The desktop app opens them from the host through
    // the editor's own `wsl+<distro>` deep link instead; without a known
    // distro, fall back to exec inside the distro.
    if (input.isDesktopRenderer && input.wslDistro) {
      return wslLinks(input.wslDistro);
    }
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
 * Running distro of a desktop-local WSL backend. The catalog only knows the
 * backend id ("wsl:ubuntu" or the default-tracking "wsl:default"), so the
 * concrete distro comes from the desktop bootstrap serving the same URL.
 */
export function resolveDesktopWslDistro(input: {
  readonly target: ConnectionTarget;
  readonly httpBaseUrl: string | null;
  readonly bootstraps: ReadonlyArray<DesktopEnvironmentBootstrap>;
  /** Primary backend's distro in wsl-only mode; null in dual mode. */
  readonly primaryWslDistro?: string | null;
}): string | null {
  if (input.target._tag === "PrimaryConnectionTarget") {
    return input.primaryWslDistro ?? null;
  }
  const backendId = desktopLocalBackendId(input.target);
  if (backendId === null || !backendId.startsWith("wsl:") || input.httpBaseUrl === null) {
    return null;
  }
  const bootstrap = input.bootstraps.find((entry) => entry.httpBaseUrl === input.httpBaseUrl);
  return bootstrap?.runningDistro?.trim() || null;
}

export function useRemoteOpenResolution(environmentId: EnvironmentId | null): RemoteOpenResolution {
  const { presentation } = useEnvironmentPresentation(environmentId);
  const bootstraps = useDesktopLocalBootstraps();
  const primaryWslDistro = useDesktopPrimaryWslDistro();

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
        wslDistro: resolveDesktopWslDistro({
          target: presentation.entry.target,
          httpBaseUrl: connectionCatalogDisplayUrl(presentation.entry),
          bootstraps,
          primaryWslDistro,
        }),
      }),
      isResolved: true,
    };
  }, [bootstraps, presentation, primaryWslDistro]);
}

export function useRemoteOpenState(environmentId: EnvironmentId | null): RemoteOpenState {
  return useRemoteOpenResolution(environmentId).state;
}

/**
 * True for host-managed local backends the desktop app runs next to its
 * primary (today: the WSL backend). Their server execs editors on this
 * machine, so they get the same "Open" affordance as the primary.
 */
export function useIsDesktopLocalEnvironment(environmentId: EnvironmentId | null): boolean {
  const { presentation } = useEnvironmentPresentation(environmentId);
  return presentation !== null && isDesktopLocalConnectionTarget(presentation.entry.target);
}

/**
 * Editors offered in remote-link mode. The desktop app probes the machine the
 * renderer runs on; a browser cannot, so it offers VS Code only.
 */
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

/**
 * One-time "you need SSH keys on that machine" hint, shown in the picker menu
 * until the first remote open fires (we cannot observe SSH success from here,
 * so first click is the dismiss signal).
 */
const REMOTE_OPEN_HINT_KEY = "t3code:remote-open-hint-seen";

export function useRemoteOpenHint(): readonly [seen: boolean, markSeen: () => void] {
  const [seen, setSeen] = useLocalStorage(REMOTE_OPEN_HINT_KEY, false, Schema.Boolean);
  return [seen, () => setSeen(true)] as const;
}
