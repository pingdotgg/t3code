import {
  REMOTE_CAPABLE_EDITOR_IDS,
  remoteOpenDefinitionForEditor,
  type SystemSettingsPane,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Electron from "electron";

/**
 * Deep links to individual System Settings panes. These are app-fixed, not
 * renderer-supplied, so they skip `parseSafeExternalUrl` — which exists to keep
 * arbitrary link schemes from reaching the OS handler — and open through their
 * own path below. The pane rather than the URL crosses the IPC boundary, so a
 * renderer can only ask for one of these known destinations.
 *
 * Full Disk Access uses the post-Ventura `PrivacySecurity.extension` anchor.
 */
const SYSTEM_SETTINGS_URLS: Record<SystemSettingsPane, string> = {
  "full-disk-access":
    "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles",
};

// Remote open-in-editor deep links must reach the OS handler; every other
// non-web scheme stays blocked.
const SAFE_WEB_PROTOCOLS = new Set(["http:", "https:"]);
const REMOTE_EDITOR_OPEN_DEFINITIONS = REMOTE_CAPABLE_EDITOR_IDS.flatMap((id) => {
  const definition = remoteOpenDefinitionForEditor(id);
  return definition === undefined ? [] : [definition];
});

const hasNoUrlCredentials = (url: URL) => url.username.length === 0 && url.password.length === 0;

const isRemoteEditorUrl = (url: URL) =>
  hasNoUrlCredentials(url) &&
  REMOTE_EDITOR_OPEN_DEFINITIONS.some((definition) => {
    if (url.protocol !== `${definition.scheme}:` || url.host !== definition.urlHost) {
      return false;
    }

    const pathPrefix = `/${definition.sshPathPrefix}`;
    if (!url.pathname.startsWith(pathPrefix)) {
      return false;
    }

    const sshTargetAndPath = url.pathname.slice(pathPrefix.length);
    return sshTargetAndPath.indexOf("/") > 0;
  });

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
    readonly hasProtocolHandler: (scheme: string) => Effect.Effect<boolean>;
    /** Opens a known System Settings pane by identifier, not by URL. */
    readonly openSystemSettings: (pane: SystemSettingsPane) => Effect.Effect<boolean>;
    readonly copyText: (text: string) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/electron/ElectronShell") {}

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
  hasProtocolHandler: (scheme) =>
    Effect.sync(() => {
      try {
        return Electron.app.getApplicationNameForProtocol(`${scheme}://`) !== "";
      } catch {
        return false;
      }
    }),
  openSystemSettings: (pane) =>
    Effect.promise(() =>
      Electron.shell.openExternal(SYSTEM_SETTINGS_URLS[pane]).then(
        () => true,
        () => false,
      ),
    ),
  copyText: (text) =>
    Effect.sync(() => {
      Electron.clipboard.writeText(text);
    }),
});

export const layer = Layer.succeed(ElectronShell, make);
