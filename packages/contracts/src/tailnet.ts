import * as Schema from "effect/Schema";

import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthDiagnosticsReadScope,
  type AuthEnvironmentScope,
  AuthFilesystemReadScope,
  AuthOrchestrationReadScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  AuthStandardClientScopes,
  AuthTerminalReadScope,
} from "./auth.ts";
import { EnvironmentId, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Every grant and session a device gets through Tailscale sign-in has this subject prefix. */
export const TAILNET_SUBJECT_PREFIX = "tailscale:";

/** The auth subject of the Tailscale node with this StableID. */
export const tailnetSubject = (stableNodeId: string): string =>
  `${TAILNET_SUBJECT_PREFIX}${stableNodeId}`;

/** A two-minute grant bound to the request's DPoP key. Exchange it at `/oauth/token`. */
export const AuthTailnetSignInResult = Schema.Struct({
  credential: TrimmedNonEmptyString,
  expiresAt: Schema.DateTimeUtc,
});
export type AuthTailnetSignInResult = typeof AuthTailnetSignInResult.Type;

/** The app capability a tailnet grant gives a device to sign in, with `{ "scopes": [...] }`. */
export const TAILNET_APP_CAPABILITY = "t3.codes/cap/t3code";

export const TAILNET_POLICY_URL = "https://login.tailscale.com/admin/acls/file";

const READ_SCOPES: ReadonlyArray<AuthEnvironmentScope> = [
  AuthOrchestrationReadScope,
  AuthDiagnosticsReadScope,
  AuthTerminalReadScope,
  AuthFilesystemReadScope,
  AuthAccessReadScope,
  AuthRelayReadScope,
];
// Pairing codes, sessions, blocks and the T3 Connect link are admin only. A standard
// device still has terminals, so this keeps T3 Code's access settings from it, not the box.
const ADMIN_ONLY: ReadonlySet<AuthEnvironmentScope> = new Set([
  AuthAccessWriteScope,
  AuthRelayWriteScope,
]);

/** The scope presets a grant can name, smallest first. A Map, so `__proto__` names nothing. */
export const TAILNET_GRANT_PRESETS: ReadonlyMap<
  string,
  ReadonlyArray<AuthEnvironmentScope>
> = new Map([
  ["read", READ_SCOPES],
  ["standard", AuthStandardClientScopes.filter((scope) => !ADMIN_ONLY.has(scope))],
  ["admin", AuthStandardClientScopes],
]);

/** Denial text for a Tailscale session that lacks `scope`: what to add to its grant, and where. */
export const tailnetScopeDenial = (scope: string): string => {
  const preset = [...TAILNET_GRANT_PRESETS].find(([, scopes]) =>
    scopes.some((granted) => granted === scope),
  )?.[0];
  return `This device's tailnet grant does not include ${scope}. Add "${scope}"${preset === undefined ? "" : ` or "${preset}"`} to its ${TAILNET_APP_CAPABILITY} grant in your tailnet policy at ${TAILNET_POLICY_URL}.`;
};

/**
 * The smallest tailnet policy grant that lets `src` (a login, tag, or address)
 * sign in to `dst` (a tag or address) on `port` with standard scopes. A `note`
 * names them, as addresses do not say whose they are.
 */
export const tailnetGrantSnippet = (
  src: string,
  dst: string,
  port: number,
  note?: string,
): string =>
  [
    '"grants": [{',
    ...(note === undefined ? [] : [`  // ${note}`]),
    `  "src": [${JSON.stringify(src)}],`,
    `  "dst": [${JSON.stringify(dst)}],`,
    `  "ip":  ["tcp:${port}"],`,
    `  "app": { "${TAILNET_APP_CAPABILITY}": [{ "scopes": ["standard"] }] }`,
    "}]",
  ].join("\n");

/** Why this host refused Tailscale sign-in. Each reason is a check from the security model. */
export const TailnetSignInRefusedReason = Schema.Literals([
  "disabled",
  "browser_request",
  "not_direct_tailnet",
  "tailscale_unavailable",
  "tailscale_outdated",
  "owner_unknown",
  "tagged_device",
  "shared_device",
  "other_user",
  "own_node",
  "routes_for_others",
  "no_grant",
  "grant_unusable",
  "policy_unknown",
  "blocked",
  "rate_limited",
]);
export type TailnetSignInRefusedReason = typeof TailnetSignInRefusedReason.Type;

/** A device that signed in through Tailscale, or one this host blocks. */
export const TailnetDevice = Schema.Struct({
  stableNodeId: TrimmedNonEmptyString,
  label: Schema.NullOr(TrimmedNonEmptyString),
  blockedAt: Schema.NullOr(Schema.DateTimeUtc),
  activeSessionCount: NonNegativeInt,
  /** The device asking, so blocking it cuts the asker off. */
  current: Schema.Boolean,
});
export type TailnetDevice = typeof TailnetDevice.Type;

export const TailnetDeviceInput = Schema.Struct({
  stableNodeId: TrimmedNonEmptyString,
});
export type TailnetDeviceInput = typeof TailnetDeviceInput.Type;

export const TailnetDeviceList = Schema.Struct({
  devices: Schema.Array(TailnetDevice),
});
export type TailnetDeviceList = typeof TailnetDeviceList.Type;

/** A dotted IPv4 address in 100.64.0.0/10, where Tailscale assigns node addresses. */
export const TailnetIpv4 = Schema.String.check(
  Schema.isPattern(
    /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){2}$/u,
  ),
);

/** Another T3 Code environment on this host's tailnet. Holds no route or credential. */
export const TailnetPeerEnvironment = Schema.Struct({
  name: TrimmedNonEmptyString,
  magicDnsName: Schema.NullOr(TrimmedNonEmptyString),
  tailnetIpv4: TailnetIpv4,
  environmentId: EnvironmentId,
});
export type TailnetPeerEnvironment = typeof TailnetPeerEnvironment.Type;

export const TailnetPeerList = Schema.Struct({
  peers: Schema.Array(TailnetPeerEnvironment),
});
export type TailnetPeerList = typeof TailnetPeerList.Type;

export class TailnetAccessError extends Schema.TaggedError<TailnetAccessError>()(
  "TailnetAccessError",
  {
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

/** A machine's own Tailscale. `unreadable` means `tailscale status` failed in another way. */
export const TailscaleState = Schema.Literals([
  "running",
  "not_installed",
  "not_running",
  "needs_login",
  "needs_machine_approval",
  "stopped",
  "starting",
  "unreadable",
]);
export type TailscaleState = typeof TailscaleState.Type;

/** Maps tailscaled's `BackendState`. `NoState` is a daemon that has only just started. */
export function tailscaleStateFromBackend(backendState: string | null): TailscaleState {
  switch (backendState) {
    case "Running":
      return "running";
    case "NeedsLogin":
      return "needs_login";
    case "NeedsMachineAuth":
      return "needs_machine_approval";
    case "Stopped":
      return "stopped";
    case "Starting":
    case "NoState":
      return "starting";
    default:
      return "unreadable";
  }
}
