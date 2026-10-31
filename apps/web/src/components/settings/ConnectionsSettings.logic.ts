import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import { resolveDesktopPairingUrl, resolveHostedPairingUrl } from "./pairingUrls";
import { getPairingTokenFromUrl, setPairingTokenOnUrl } from "@t3tools/shared/remote";
import { readHostedPairingRequest } from "../../hostedPairing";
import { randomUUID } from "~/lib/utils";
import {
  type ServerClientSessionRecord,
  type ServerPairingLinkRecord,
} from "~/environments/primary";
import {
  type AdvertisedEndpoint,
  type AuthClientSession,
  type AuthGrantScope,
  type AuthPairingLink,
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
  type DesktopBridge,
  type DesktopGatewayHeader,
  type DesktopGatewayHeadersInput,
  DesktopGatewayHeaderSchema,
  isReservedGatewayHeaderName,
  type DesktopServerExposureState,
  type DesktopSshEnvironmentTarget,
  type DesktopUpdateState,
  type DesktopWslState,
} from "@t3tools/contracts";
import {
  getDesktopUpdateDownloadedVersion,
  resolveDesktopUpdateButtonAction,
} from "../desktopUpdate.logic";

/** Keep terminal:read with terminal:operate to avoid creating unseen shells on every script run. */
export function togglePairingScopeSelection(
  current: ReadonlyArray<AuthGrantScope>,
  scope: AuthGrantScope,
  checked: boolean,
): ReadonlyArray<AuthGrantScope> {
  const without = (scopes: ReadonlyArray<AuthGrantScope>) =>
    scopes.filter((currentScope) => currentScope !== scope);
  if (!checked) {
    return scope === AuthTerminalReadScope
      ? without(current).filter((currentScope) => currentScope !== AuthTerminalOperateScope)
      : without(current);
  }
  const next = [...without(current), scope];
  return scope === AuthTerminalOperateScope && !next.includes(AuthTerminalReadScope)
    ? [...next, AuthTerminalReadScope]
    : next;
}

export function canRevokeOtherClients(
  clientSessions: ReadonlyArray<{ readonly current: boolean }> | null,
): boolean {
  return clientSessions === null || clientSessions.some((session) => !session.current);
}

type WslEnableBridge = Pick<DesktopBridge, "setWslBackendEnabled" | "setWslDistro" | "setWslOnly">;

/** Never offer loopback URLs as QR targets; scanning devices would connect to themselves. */
export function isQrShareableEndpoint(endpoint: AdvertisedEndpoint): boolean {
  return endpoint.status !== "unavailable" && endpoint.reachability !== "loopback";
}

/** Desktop skips Tailscale probing until network/Serve is enabled to avoid macOS prompts; absence then
 * means unchecked. */
export function missingTailscaleEndpointDescription(
  state: Pick<DesktopServerExposureState, "mode" | "tailscaleServeEnabled"> | null,
): string {
  return state && state.mode !== "network-accessible" && !state.tailscaleServeEnabled
    ? "Turn on Network access to detect Tailscale."
    : "Start Tailscale to set up HTTPS access through MagicDNS.";
}

export function resolveTailscaleServeBaseUrl(
  endpoint: Pick<AdvertisedEndpoint, "httpBaseUrl"> | null,
  port: number,
  isPortValid: boolean,
): string | null {
  if (!endpoint) return null;
  if (!isPortValid) return endpoint.httpBaseUrl;
  try {
    const url = new URL(endpoint.httpBaseUrl);
    url.port = String(port);
    return url.toString().replace(/\/$/u, "");
  } catch {
    return endpoint.httpBaseUrl;
  }
}

export function isWslSettingsRowVisible(input: {
  readonly state: DesktopWslState | null;
  readonly error: string | null;
}): boolean {
  const { state, error } = input;
  return state ? state.available || state.enabled || state.wslOnly : error !== null;
}

/**
 * Once client/server versions match, this passive Version label follows the sidebar update action,
 * including retryable failures. Rechecks retain downloaded-update labels; `state` is null outside desktop.
 */
export function resolveLocalVersionStatusLabel(state: DesktopUpdateState | null): string {
  if (!state) return "Up to date";
  if (state.status === "downloading") {
    return state.availableVersion
      ? `Downloading update ${state.availableVersion}`
      : "Downloading update";
  }
  const action = resolveDesktopUpdateButtonAction(state);
  if (
    action === "install" ||
    state.status === "downloaded" ||
    (state.status === "checking" && state.downloadedVersion !== null)
  ) {
    const version = getDesktopUpdateDownloadedVersion(state);
    return version ? `Update ${version} downloaded` : "Update downloaded";
  }
  if (action === "download") {
    return state.availableVersion
      ? `Update ${state.availableVersion} available`
      : "Update available";
  }
  return "Up to date";
}

export type QrEndpointOption = {
  readonly id: string;
  /** Stable per endpoint type, not unique; used only to match the saved default. */
  readonly preferenceKey: string;
  readonly qrShareable: boolean;
};

export function selectQrEndpointOption<T extends QrEndpointOption>(
  options: ReadonlyArray<T>,
  selectedId: string | null,
  defaultPreferenceKey: string | null,
): T | null {
  return (
    (selectedId !== null ? options.find((option) => option.id === selectedId) : undefined) ??
    (defaultPreferenceKey !== null
      ? options.find((option) => option.preferenceKey === defaultPreferenceKey)
      : undefined) ??
    options.find((option) => option.qrShareable) ??
    options[0] ??
    null
  );
}

export async function applyWslEnableSelection(input: {
  readonly bridge: WslEnableBridge;
  readonly mode: "both" | "wsl-only";
  readonly nextDistro: string | null;
  readonly persistedDistro: string | null;
}): Promise<DesktopWslState> {
  const { bridge, mode, nextDistro, persistedDistro } = input;

  // Stage preferences before enabling; only the final call should relaunch WSL with the complete selection.
  await bridge.setWslOnly(mode === "wsl-only");
  if (persistedDistro !== nextDistro) {
    await bridge.setWslDistro(nextDistro);
  }
  return await bridge.setWslBackendEnabled(true);
}

const accessTimestampFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function formatAccessTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return accessTimestampFormatter.format(parsed);
}

export function parseManualDesktopSshTarget(input: {
  readonly host: string;
  readonly username: string;
  readonly port: string;
}): DesktopSshEnvironmentTarget {
  const rawHost = input.host.trim();
  if (rawHost.length === 0) {
    throw new Error("SSH host or alias is required.");
  }

  let hostname = rawHost;
  let username = input.username.trim() || null;
  let port: number | null = null;

  const atIndex = hostname.lastIndexOf("@");
  if (atIndex > 0) {
    const inlineUsername = hostname.slice(0, atIndex).trim();
    hostname = hostname.slice(atIndex + 1).trim();
    if (!username && inlineUsername.length > 0) {
      username = inlineUsername;
    }
  }

  const bracketedHostMatch = /^\[([^\]]+)\](?::(\d+))?$/u.exec(hostname);
  if (bracketedHostMatch) {
    hostname = bracketedHostMatch[1]!.trim();
    if (bracketedHostMatch[2]) {
      port = Number.parseInt(bracketedHostMatch[2], 10);
    }
  } else {
    const colonSegments = hostname.split(":");
    if (colonSegments.length === 2 && /^\d+$/u.test(colonSegments[1] ?? "")) {
      hostname = colonSegments[0]!.trim();
      port = Number.parseInt(colonSegments[1]!, 10);
    }
  }

  const rawPort = input.port.trim();
  if (rawPort.length > 0) {
    port = Number.parseInt(rawPort, 10);
  }

  if (hostname.length === 0) {
    throw new Error("SSH host or alias is required.");
  }

  if (port !== null && (!Number.isInteger(port) || port <= 0 || port > 65_535)) {
    throw new Error("SSH port must be between 1 and 65535.");
  }

  return {
    alias: hostname,
    hostname,
    username,
    port,
  };
}

export function parsePairingUrlFields(
  input: string,
): { readonly host: string; readonly pairingCode: string } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  try {
    const urlLikeInput =
      /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//u.test(trimmed) || trimmed.startsWith("//")
        ? trimmed
        : `https://${trimmed}`;
    const url = new URL(urlLikeInput, window.location.origin);
    const hostedPairingRequest = readHostedPairingRequest(url);
    if (hostedPairingRequest) {
      return {
        host: hostedPairingRequest.host,
        pairingCode: hostedPairingRequest.token,
      };
    }

    const pairingCode = getPairingTokenFromUrl(url);
    if (!pairingCode) return null;
    return {
      host: url.origin,
      pairingCode,
    };
  } catch {
    return null;
  }
}

export function parseRemotePairingFields(input: {
  readonly host: string;
  readonly pairingCode: string;
}): {
  readonly host: string;
  readonly pairingCode: string;
} {
  const parsedPairingUrl = parsePairingUrlFields(input.host);
  if (parsedPairingUrl) return parsedPairingUrl;

  const host = input.host.trim();
  const pairingCode = input.pairingCode.trim();
  if (!host) {
    throw new Error("Enter a backend host.");
  }
  if (!pairingCode) {
    throw new Error("Enter a pairing code.");
  }
  return { host, pairingCode };
}

const isGatewayHeader = Schema.is(DesktopGatewayHeaderSchema);

/** The origin gateway headers are saved for. A bare host means https, as it does when pairing. */
export function resolveGatewayOrigin(host: string): string {
  const trimmed = host.trim().replace(/^\/+/u, "");
  if (trimmed.length === 0) throw new Error("Enter the environment address.");
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z\d+-]*:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    throw new Error("Enter a valid environment address.");
  }
  if (url.protocol === "ws:") url.protocol = "http:";
  else if (url.protocol === "wss:") url.protocol = "https:";
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The environment address must use http or https.");
  }
  return url.origin;
}

const CLOUDFLARE_ACCESS_HEADER_NAMES = ["CF-Access-Client-Id", "CF-Access-Client-Secret"] as const;

export interface GatewayHeaderRow {
  readonly id: string;
  readonly name: string;
  readonly value: string;
}

export interface GatewayHeadersDraft {
  readonly kind: "cloudflare" | "custom";
  readonly clientId: string;
  readonly clientSecret: string;
  readonly rows: ReadonlyArray<GatewayHeaderRow>;
}

export function makeGatewayHeaderRow(name = ""): GatewayHeaderRow {
  return { id: randomUUID(), name, value: "" };
}

export function isCloudflareAccessHeaderNames(names: ReadonlyArray<string>): boolean {
  return (
    names.length === CLOUDFLARE_ACCESS_HEADER_NAMES.length &&
    CLOUDFLARE_ACCESS_HEADER_NAMES.every((expected) =>
      names.some((name) => name.toLowerCase() === expected.toLowerCase()),
    )
  );
}

/** Saved values never come back from the desktop app, so a replacement keeps only the names. */
export function makeGatewayHeadersDraft(
  savedHeaderNames: ReadonlyArray<string> = [],
): GatewayHeadersDraft {
  const cloudflare =
    savedHeaderNames.length === 0 || isCloudflareAccessHeaderNames(savedHeaderNames);
  return {
    kind: cloudflare ? "cloudflare" : "custom",
    clientId: "",
    clientSecret: "",
    rows: cloudflare ? [makeGatewayHeaderRow()] : savedHeaderNames.map(makeGatewayHeaderRow),
  };
}

function validateGatewayHeaders(
  headers: ReadonlyArray<DesktopGatewayHeader>,
): ReadonlyArray<DesktopGatewayHeader> {
  const seen = new Set<string>();
  for (const header of headers) {
    const { name, value } = header;
    if (name.length === 0) throw new Error("Enter a name for each header.");
    if (value.length === 0) throw new Error(`Enter a value for ${name}.`);
    if (isReservedGatewayHeaderName(name)) throw new Error(`T3 Code sets ${name} itself.`);
    if (!isGatewayHeader({ name, value: "x" })) {
      throw new Error(`${name} is not a valid header name.`);
    }
    if (!isGatewayHeader(header)) throw new Error(`The value of ${name} has invalid characters.`);
    if (seen.has(name.toLowerCase())) throw new Error(`${name} is listed twice.`);
    seen.add(name.toLowerCase());
  }
  return headers;
}

/** Empty when nothing is filled in. Errors name a header but never echo a value. */
export function gatewayHeadersFromDraft(
  draft: GatewayHeadersDraft,
): ReadonlyArray<DesktopGatewayHeader> {
  if (draft.kind === "custom") {
    return validateGatewayHeaders(
      draft.rows
        .map((row) => ({ name: row.name.trim(), value: row.value.trim() }))
        .filter((row) => row.name.length > 0 || row.value.length > 0),
    );
  }
  const clientId = draft.clientId.trim();
  const clientSecret = draft.clientSecret.trim();
  if (clientId.length === 0 && clientSecret.length === 0) return [];
  if (clientId.length === 0) throw new Error("Enter the service token's client ID.");
  if (clientSecret.length === 0) throw new Error("Enter the service token's client secret.");
  return validateGatewayHeaders([
    { name: CLOUDFLARE_ACCESS_HEADER_NAMES[0], value: clientId },
    { name: CLOUDFLARE_ACCESS_HEADER_NAMES[1], value: clientSecret },
  ]);
}

/** `origin` is set when replacing a saved origin's headers; otherwise `host` names it. */
export function resolveGatewayHeadersInput(input: {
  readonly origin: string | null;
  readonly host: string;
  readonly draft: GatewayHeadersDraft;
}): DesktopGatewayHeadersInput {
  const origin = input.origin ?? resolveGatewayOrigin(input.host);
  const headers = gatewayHeadersFromDraft(input.draft);
  if (headers.length === 0) {
    throw new Error(
      input.draft.kind === "cloudflare"
        ? "Enter the service token's client ID and client secret."
        : "Add at least one header.",
    );
  }
  return { origin, headers };
}

/** An https origin on its default port reads as its host. */
export function formatGatewayOrigin(origin: string): string {
  const url = new URL(origin);
  return url.protocol === "https:" ? url.host : origin;
}

export function formatDesktopBridgeError(error: unknown, fallback: string): string {
  const rawMessage = error instanceof Error ? error.message : fallback;
  return (
    rawMessage
      .replace(/^Error invoking remote method '[^']+':\s*/u, "")
      .replace(/^[A-Za-z]+Error:\s*/u, "")
      .trim() || fallback
  );
}

export function formatDesktopSshConnectionError(error: unknown): string {
  const fallback = "Failed to connect SSH host.";
  const rawMessage = error instanceof Error ? error.message : fallback;
  const withoutIpcPrefix = rawMessage.replace(
    /^Error invoking remote method 'desktop:ensure-ssh-environment':\s*/u,
    "",
  );
  const withoutTaggedErrorPrefix = withoutIpcPrefix.replace(/^Ssh[A-Za-z]+Error:\s*/u, "");
  return withoutTaggedErrorPrefix.trim() || fallback;
}

export function sortDesktopPairingLinks(links: ReadonlyArray<ServerPairingLinkRecord>) {
  return [...links].toSorted(
    (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
  );
}

export function summarizeAuthorizedClients(
  sessions: ReadonlyArray<ServerClientSessionRecord>,
  links: ReadonlyArray<ServerPairingLinkRecord>,
): string {
  const parts = [
    `${sessions.length} ${sessions.length === 1 ? "client" : "clients"}`,
    links.length > 0
      ? `${links.length} ${links.length === 1 ? "pairing link" : "pairing links"}`
      : null,
  ];
  return parts.filter((part): part is string => part !== null).join(" · ");
}

export function sortDesktopClientSessions(sessions: ReadonlyArray<ServerClientSessionRecord>) {
  return [...sessions].toSorted((left, right) => {
    if (left.current !== right.current) {
      return left.current ? -1 : 1;
    }
    if (left.connected !== right.connected) {
      return left.connected ? -1 : 1;
    }
    return new Date(right.issuedAt).getTime() - new Date(left.issuedAt).getTime();
  });
}

export function toDesktopPairingLinkRecord(pairingLink: AuthPairingLink): ServerPairingLinkRecord {
  return {
    ...pairingLink,
    scopes: pairingLink.permissions ?? pairingLink.scopes,
    createdAt: DateTime.formatIso(pairingLink.createdAt),
    expiresAt: DateTime.formatIso(pairingLink.expiresAt),
  };
}

export function toDesktopClientSessionRecord(
  clientSession: AuthClientSession,
): ServerClientSessionRecord {
  return {
    ...clientSession,
    scopes: clientSession.permissions ?? clientSession.scopes,
    issuedAt: DateTime.formatIso(clientSession.issuedAt),
    expiresAt: DateTime.formatIso(clientSession.expiresAt),
    lastConnectedAt:
      clientSession.lastConnectedAt === null
        ? null
        : DateTime.formatIso(clientSession.lastConnectedAt),
  };
}

export function selectPairingEndpoint(
  endpoints: ReadonlyArray<AdvertisedEndpoint>,
  defaultEndpointKey?: string | null,
): AdvertisedEndpoint | null {
  const availableEndpoints = endpoints.filter((endpoint) => endpoint.status !== "unavailable");
  if (defaultEndpointKey) {
    const selectedEndpoint = availableEndpoints.find(
      (endpoint) => endpointDefaultPreferenceKey(endpoint) === defaultEndpointKey,
    );
    if (selectedEndpoint) {
      return selectedEndpoint;
    }
  }
  return (
    availableEndpoints.find((endpoint) => endpoint.isDefault) ??
    availableEndpoints.find((endpoint) => endpoint.reachability !== "loopback") ??
    availableEndpoints.find((endpoint) => endpoint.compatibility.hostedHttpsApp === "compatible") ??
    null
  );
}

export function isTailscaleHttpsEndpoint(endpoint: AdvertisedEndpoint): boolean {
  return endpoint.id.startsWith("tailscale-magicdns:");
}

export function endpointDefaultPreferenceKey(endpoint: AdvertisedEndpoint): string {
  if (endpoint.id.startsWith("desktop-loopback:")) {
    return "desktop-core:loopback:http";
  }
  if (endpoint.id.startsWith("desktop-lan:")) {
    return "desktop-core:lan:http";
  }
  if (endpoint.id.startsWith("tailscale-ip:")) {
    return "tailscale:ip:http";
  }
  if (isTailscaleHttpsEndpoint(endpoint)) {
    return "tailscale:magicdns:https";
  }

  let scheme = "unknown";
  try {
    scheme = new URL(endpoint.httpBaseUrl).protocol.replace(/:$/u, "");
  } catch {}

  return `${endpoint.provider.id}:${endpoint.reachability}:${scheme}:${endpoint.label}`;
}

export function resolveAdvertisedEndpointPairingUrl(
  endpoint: AdvertisedEndpoint,
  credential: string,
): string {
  if (endpoint.compatibility.hostedHttpsApp === "compatible") {
    return (
      resolveHostedPairingUrl(endpoint.httpBaseUrl, credential) ??
      resolveDesktopPairingUrl(endpoint.httpBaseUrl, credential)
    );
  }
  return resolveDesktopPairingUrl(endpoint.httpBaseUrl, credential);
}

export function resolveCurrentOriginPairingUrl(credential: string): string {
  const url = new URL("/pair", window.location.href);
  return setPairingTokenOnUrl(url, credential).toString();
}

export function isHostedAppPairingUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.pathname === "/pair" && url.searchParams.has("host");
  } catch {
    return false;
  }
}

export function endpointShareHint(endpoint: AdvertisedEndpoint, url: string): string {
  if (isHostedAppPairingUrl(url)) {
    return "Opens the hosted app, no install needed";
  }
  switch (endpoint.reachability) {
    case "lan":
      return "Devices on the same network";
    case "private-network":
      return "Devices on your private network";
    case "public":
      return "Reachable from anywhere";
    case "loopback":
      return "Clients on this machine";
  }
}
