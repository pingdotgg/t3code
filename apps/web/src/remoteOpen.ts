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
import {
  REMOTE_CAPABLE_EDITOR_IDS,
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
import { useEnvironmentPresentation } from "~/state/presentation";

export interface RemoteOpenHost {
  readonly kind: "ssh-alias" | RemoteOpenTarget["kind"];
  readonly host: string;
}

export type RemoteOpenState =
  | { readonly mode: "local-exec" }
  | { readonly mode: "remote-links"; readonly host: RemoteOpenHost }
  | { readonly mode: "remote-unavailable" };

export type RemoteOpenMode = RemoteOpenState["mode"];

const LOCAL_EXEC: RemoteOpenState = { mode: "local-exec" };
const REMOTE_UNAVAILABLE: RemoteOpenState = { mode: "remote-unavailable" };

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

export function useRemoteOpenState(environmentId: EnvironmentId | null): RemoteOpenState {
  const { presentation } = useEnvironmentPresentation(environmentId);

  return useMemo(() => {
    if (presentation === null) {
      return LOCAL_EXEC;
    }
    const profile = Option.getOrNull(presentation.entry.profile);
    const sshAlias =
      profile !== null && profile._tag === "SshConnectionProfile" ? profile.target.alias : null;
    return resolveRemoteOpenState({
      target: presentation.entry.target,
      sshAlias,
      remoteOpenTargets: presentation.serverConfig?.remoteOpenTargets,
      isDesktopRenderer: window.desktopBridge !== undefined,
    });
  }, [presentation]);
}

/**
 * Editors offered in remote-link mode. The desktop app probes the machine the
 * renderer runs on; a browser cannot, so it offers VS Code only.
 */
const REMOTE_FALLBACK_EDITORS: ReadonlyArray<EditorId> = ["vscode"];

let cachedProbedEditors: ReadonlyArray<EditorId> | null = null;

export function __resetRemoteEditorProbeForTests(): void {
  cachedProbedEditors = null;
}

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
