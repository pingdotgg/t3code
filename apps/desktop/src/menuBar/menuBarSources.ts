import { credentialConnectionId } from "@lathe/client-runtime/connection";
import type { ConnectionCatalogDocument } from "@lathe/client-runtime/platform";
import type { DesktopSshEnvironmentTarget, EnvironmentId } from "@lathe/contracts";

interface SourceBase {
  /** Stable while the saved connection is unchanged, so a catalog write restarts only what it touched. */
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export type MenuBarRemoteSource = SourceBase &
  (
    | {
        readonly _tag: "bearer";
        readonly httpBaseUrl: string;
        readonly wsBaseUrl: string;
        readonly token: string;
      }
    | {
        readonly _tag: "ssh";
        readonly target: DesktopSshEnvironmentTarget;
        readonly token: string;
      }
    | { readonly _tag: "unsupported"; readonly reason: string }
  );

const LATHE_CONNECT_REASON = "Lathe Connect environments are not shown in the menu bar yet.";
const RECONNECT_REASON = "Open Lathe to reconnect.";

/**
 * Main reads the renderer's catalog but never writes it: the renderer caches the whole document
 * and writes it back, so a write from main would be lost. Anything that needs a new credential
 * is left for the window to fix.
 */
export function menuBarRemoteSources(
  catalog: ConnectionCatalogDocument,
): ReadonlyArray<MenuBarRemoteSource> {
  const disabled = new Set(catalog.disabledEnvironmentIds);
  const profiles = new Map(catalog.profiles.map((profile) => [profile.connectionId, profile]));
  // A DPoP token needs proofs from the renderer's device key, so only bearer tokens work here.
  const tokens = new Map(
    catalog.credentials.flatMap((entry) =>
      entry.credential._tag === "BearerConnectionCredential"
        ? [[entry.connectionId, entry.credential.token] as const]
        : [],
    ),
  );
  const sources: Array<MenuBarRemoteSource> = [];
  for (const target of catalog.targets) {
    if (disabled.has(target.environmentId)) continue;
    const base = { environmentId: target.environmentId, label: target.label };
    if (target._tag === "RelayConnectionTarget") {
      sources.push({
        ...base,
        _tag: "unsupported",
        key: `relay:${target.environmentId}`,
        reason: LATHE_CONNECT_REASON,
      });
      continue;
    }
    const key = target.connectionId;
    const profile = profiles.get(key);
    const token = tokens.get(credentialConnectionId(key));
    if (profile?._tag === "BearerConnectionProfile" && profile.authorization === "t3-connect") {
      sources.push({ ...base, _tag: "unsupported", key, reason: LATHE_CONNECT_REASON });
    } else if (
      target._tag === "BearerConnectionTarget" &&
      profile?._tag === "BearerConnectionProfile" &&
      token
    ) {
      const { httpBaseUrl, wsBaseUrl } = profile;
      sources.push({ ...base, _tag: "bearer", key, httpBaseUrl, wsBaseUrl, token });
    } else if (
      target._tag === "SshConnectionTarget" &&
      profile?._tag === "SshConnectionProfile" &&
      token
    ) {
      sources.push({ ...base, _tag: "ssh", key, target: profile.target, token });
    } else {
      sources.push({ ...base, _tag: "unsupported", key, reason: RECONNECT_REASON });
    }
  }
  return sources;
}
