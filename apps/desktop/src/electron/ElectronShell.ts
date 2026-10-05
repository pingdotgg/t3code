import { MAC_PERMISSION_SETTINGS_URLS } from "../permissions/MacPermission.ts";
import {
  REMOTE_CAPABLE_EDITOR_IDS,
  WSL_CAPABLE_EDITOR_IDS,
  isWslDistroName,
  remoteSchemeForEditor,
  type SystemSettingsPane,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Electron from "electron";

// Editor deep links (`vscode://vscode-remote/ssh-remote+…`,
// `vscode://vscode-remote/wsl+…`, `zed://ssh/<host>/<path>`) reach the OS handler; other non-web
// scheme stays blocked.
const SAFE_WEB_PROTOCOLS = new Set(["http:", "https:"]);
const REMOTE_EDITOR_PROTOCOLS = new Set(
  REMOTE_CAPABLE_EDITOR_IDS.flatMap((id) => {
    const scheme = remoteSchemeForEditor(id);
    return scheme === undefined ? [] : [`${scheme}:`];
  }),
);
const WSL_EDITOR_PROTOCOLS = new Set(
  WSL_CAPABLE_EDITOR_IDS.map((id) => `${remoteSchemeForEditor(id)}:`),
);

/**
 * Checks the WSL path and editor protocol after the caller validates the host
 * and credentials. Malformed distro encoding is rejected by parseSafeExternalUrl.
 */
function isWslEditorUrl(url: URL): boolean {
  const match = /^\/wsl\+([^/]+)\//.exec(url.pathname);
  const distro = match?.[1];
  return (
    WSL_EDITOR_PROTOCOLS.has(url.protocol) &&
    distro !== undefined &&
    isWslDistroName(decodeURIComponent(distro))
  );
}

// Zed's host sits in the first path segment, so it needs its own userinfo ban.
const ZED_SSH_PATHNAME = /^\/[^/@:]+\/.*$/;

/** Allows supported SSH and WSL editor links without embedded credentials. */
function isRemoteEditorUrl(url: URL) {
  return (
    REMOTE_EDITOR_PROTOCOLS.has(url.protocol) &&
    url.username.length === 0 &&
    url.password.length === 0 &&
    (url.protocol === "zed:"
      ? url.host === "ssh" && ZED_SSH_PATHNAME.test(url.pathname)
      : url.host === "vscode-remote" &&
        ((url.pathname.startsWith("/ssh-remote+") && url.pathname.length > "/ssh-remote+".length) ||
          isWslEditorUrl(url)))
  );
}

/** Returns a normalized web or supported editor URL that the OS may open. */
export function parseSafeExternalUrl(rawUrl: unknown): Option.Option<string> {
  if (typeof rawUrl !== "string") {
    return Option.none();
  }

  try {
    const url = new URL(rawUrl);
    return SAFE_WEB_PROTOCOLS.has(url.protocol) || isRemoteEditorUrl(url)
      ? Option.some(url.href)
      : Option.none();
  } catch {
    return Option.none();
  }
}

export class ElectronShell extends Context.Service<
  ElectronShell,
  {
    readonly openExternal: (rawUrl: unknown) => Effect.Effect<boolean>;
    /** Opens a known System Settings pane by identifier, not by URL. */
    readonly openSystemSettings: (pane: SystemSettingsPane) => Effect.Effect<boolean>;
    readonly copyText: (text: string) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/electron/ElectronShell") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = ElectronShell.of({
  openExternal: (rawUrl) =>
    Option.match(parseSafeExternalUrl(rawUrl), {
      onNone: () => Effect.succeed(false),
      onSome: (externalUrl) =>
        Effect.promise(() =>
          Electron.shell.openExternal(externalUrl).then(
            () => true,
            () => false,
          ),
        ),
    }),
  openSystemSettings: (pane) =>
    Effect.promise(() =>
      Electron.shell.openExternal(MAC_PERMISSION_SETTINGS_URLS[pane]).then(
        () => true,
        () => false,
      ),
    ),
  copyText: (text) =>
    Effect.promise(() => Electron.clipboard.writeText(text).catch(() => undefined)),
});

export const layer = Layer.succeed(ElectronShell, make);
