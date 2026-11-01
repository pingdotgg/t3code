import {
  type AuthClientPresentationMetadata,
  type EnvironmentId,
  TailnetIpv4,
  type TailnetPeerEnvironment,
  TAILNET_APP_CAPABILITY,
  TAILNET_POLICY_URL,
  type TailnetSignInRefusedReason,
} from "@t3tools/contracts";
import { isSharedAddressSpaceHost, normalizeHostname } from "@t3tools/shared/hostClassification";
import * as Schema from "effect/Schema";

import type { ConnectionCatalogEntry } from "./catalog.ts";
import { ConnectionBlockedError, ConnectionTransientError } from "./model.ts";
import { connectionRoutes, routeHttpBaseUrl } from "./routes.ts";

/** Where `t3 up` and the desktop "Tailscale sign-in" switch listen. */
export const TAILNET_SIGN_IN_PORT = 3773;

const SINGLE_LABEL_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

const isTailnetIpv4 = Schema.is(TailnetIpv4);

function isTailnetName(hostname: string): boolean {
  if (hostname.endsWith(".ts.net")) return true;
  return SINGLE_LABEL_HOST.test(hostname) && !/^\d+$/u.test(hostname) && hostname !== "localhost";
}

/**
 * The direct tailnet address to sign in at, from what a user typed or scanned:
 * `studio`, `studio.tailnet.ts.net`, or `100.x.y.z`, each with an optional
 * port, or a plain `http://` URL with no pairing code (the `t3 up` QR). Null
 * for anything else, which goes to the pairing-code flow.
 */
export function tailnetSignInBaseUrl(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  const hasScheme = /^[a-z][a-z\d+.-]*:\/\//iu.test(trimmed);
  let url: URL;
  try {
    url = new URL(hasScheme ? trimmed : `http://${trimmed}`);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" || url.username !== "" || url.password !== "") return null;
  // A path, query, or fragment is a pairing link, not a bare address.
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return null;
  const hostname = normalizeHostname(url.hostname);
  if (!isSharedAddressSpaceHost(hostname) && !isTailnetName(hostname)) return null;
  // URL drops the default port, so a typed `:80` would read as no port at all.
  const typedPort = /^(?:[a-z][a-z\d+.-]*:\/\/)?[^/?#]*:\d+(?:[/?#]|$)/iu.test(trimmed);
  const port = url.port !== "" ? url.port : typedPort ? "80" : String(TAILNET_SIGN_IN_PORT);
  return `http://${hostname}:${port}/`;
}

/** Hosts refuse browser origins, and a page on plain `http://100.x` cannot make a DPoP key. */
export function supportsTailnetSignIn(metadata: AuthClientPresentationMetadata): boolean {
  return metadata.surface === "desktop" || metadata.surface === "mobile";
}

// Off Tailscale, a pinned name can resolve to a LAN address the host refuses; it
// works again once Tailscale is back, like the other two.
const TRANSIENT_REFUSALS: ReadonlySet<TailnetSignInRefusedReason> = new Set([
  "not_direct_tailnet",
  "tailscale_unavailable",
  "rate_limited",
  // Ends on its own once the host can read the policy again.
  "policy_unknown",
]);

export function tailnetRefusalError(
  reason: TailnetSignInRefusedReason,
  traceId?: string,
  suggestedGrant?: string,
) {
  // Forms show the detail as is, before the machine has a label.
  const { headline, steps } = tailnetRefusalVerdict("that machine", reason);
  const sentence = `${headline.charAt(0).toUpperCase()}${headline.slice(1)}. ${steps.join(" ")}`;
  const fields = {
    detail:
      suggestedGrant === undefined
        ? sentence
        : `${sentence}\n\nAdd this to your tailnet policy:\n${suggestedGrant}`,
    hop: "server" as const,
    via: "direct" as const,
    tailnetRefusal: reason,
    ...(traceId === undefined ? {} : { traceId }),
    ...(suggestedGrant === undefined ? {} : { suggestedGrant }),
  };
  return TRANSIENT_REFUSALS.has(reason)
    ? new ConnectionTransientError({ reason: "remote-unavailable", ...fields })
    : new ConnectionBlockedError({ reason: "permission", ...fields });
}

export type DiscoveredMachineAction =
  | { readonly _tag: "Add" }
  | { readonly _tag: "Skip" }
  /** A saved environment answered at an address it was never saved with. */
  | { readonly _tag: "Conflict"; readonly label: string };

function routeHosts(entry: ConnectionCatalogEntry): ReadonlySet<string> {
  return new Set(
    connectionRoutes(entry).flatMap((route) => {
      const url = routeHttpBaseUrl(route);
      return url !== null && URL.canParse(url) ? [normalizeHostname(new URL(url).hostname)] : [];
    }),
  );
}

/**
 * What to do with a machine found on the tailnet. A removed machine stays
 * removed, and a found address never joins a saved environment's routes: the
 * public descriptor does not prove which machine answered.
 */
export function discoveredMachineAction(input: {
  readonly machine: Pick<TailnetPeerEnvironment, "environmentId" | "tailnetIpv4" | "magicDnsName">;
  readonly entries: ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>;
  readonly dismissed: ReadonlySet<EnvironmentId>;
}): DiscoveredMachineAction {
  const { machine } = input;
  // A connected host could name a LAN address; sign-in goes only to a tailnet one.
  if (!isTailnetIpv4(machine.tailnetIpv4)) return { _tag: "Skip" };
  if (input.dismissed.has(machine.environmentId)) return { _tag: "Skip" };
  const saved = input.entries.get(machine.environmentId);
  if (saved === undefined) return { _tag: "Add" };
  const hosts = routeHosts(saved);
  const dnsName = machine.magicDnsName === null ? null : normalizeHostname(machine.magicDnsName);
  const known =
    hosts.has(normalizeHostname(machine.tailnetIpv4)) ||
    (dnsName !== null && (hosts.has(dnsName) || hosts.has(dnsName.split(".")[0]!)));
  // Without a direct address to compare, T3 Connect and SSH routes cannot conflict.
  if (known || hosts.size === 0) return { _tag: "Skip" };
  return { _tag: "Conflict", label: saved.target.label };
}

/** Machines with `tailnetSignIn` that `discoveredMachineAction` would add, once per environment. */
export function machinesToAdd<
  Machine extends Pick<TailnetPeerEnvironment, "environmentId" | "tailnetIpv4" | "magicDnsName">,
>(input: {
  readonly machines: ReadonlyArray<Machine>;
  readonly entries: ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>;
  readonly dismissed: ReadonlySet<EnvironmentId>;
}): {
  readonly add: ReadonlyArray<Machine>;
  readonly conflicts: ReadonlyArray<{ readonly machine: Machine; readonly label: string }>;
} {
  const seen = new Set<EnvironmentId>();
  const add: Machine[] = [];
  const conflicts: Array<{ readonly machine: Machine; readonly label: string }> = [];
  for (const machine of input.machines) {
    if (seen.has(machine.environmentId)) continue;
    seen.add(machine.environmentId);
    const action = discoveredMachineAction({ ...input, machine });
    if (action._tag === "Add") add.push(machine);
    if (action._tag === "Conflict") conflicts.push({ machine, label: action.label });
  }
  return { add, conflicts };
}

const PAIR_INSTEAD = "Or pair this device with a code instead.";

/** Why a host refused this device's Tailscale sign-in, and the fix. */
export function tailnetRefusalVerdict(
  host: string,
  reason: TailnetSignInRefusedReason,
): { readonly headline: string; readonly steps: ReadonlyArray<string> } {
  const grant = `Grant this device \`${TAILNET_APP_CAPABILITY}\` on ${host} in your tailnet policy at ${TAILNET_POLICY_URL}.`;
  switch (reason) {
    case "disabled":
      return {
        headline: `Tailscale sign-in is off on ${host}`,
        steps: [
          `On ${host}, run \`npx t3 up --tailscale\`, or turn on Tailscale sign-in in Settings.`,
          PAIR_INSTEAD,
        ],
      };
    case "browser_request":
      return {
        headline: `${host} accepts Tailscale sign-in only from the desktop and mobile apps`,
        steps: ["Pair this browser with a code."],
      };
    case "not_direct_tailnet":
      return {
        headline: `${host} did not see this device on its Tailscale address`,
        steps: [
          "Turn on Tailscale on this device, and log in to it again if it asks. Saved machines retry on their own.",
          `Add ${host} by its Tailscale name or 100.x address, not a LAN or HTTPS address.`,
        ],
      };
    case "tailscale_unavailable":
      return {
        headline: `${host} could not ask Tailscale who this device is`,
        steps: [`On ${host}, check that Tailscale runs, or run \`t3 tailscale status\`.`],
      };
    case "tailscale_outdated":
      return {
        headline: `${host} runs a Tailscale too old for sign-in`,
        steps: [`Update Tailscale on ${host}.`],
      };
    case "owner_unknown":
      return {
        headline: `${host} does not know who owns it`,
        steps: [grant, `Or, on ${host}, run \`npx t3 up --owner <your login>\`.`],
      };
    case "tagged_device":
      return {
        headline: `This device is tagged, and no grant lets it into ${host}`,
        steps: [grant, PAIR_INSTEAD],
      };
    case "shared_device":
      return {
        headline: `This device is shared in from another tailnet, and no grant lets it into ${host}`,
        steps: [grant, PAIR_INSTEAD],
      };
    case "other_user":
      return {
        headline: `This device belongs to another Tailscale user, and no grant lets it into ${host}`,
        steps: [grant, PAIR_INSTEAD],
      };
    case "own_node":
      return {
        headline: `This device is ${host}`,
        steps: ["Use this device's own T3 Code instead."],
      };
    case "routes_for_others":
      return {
        headline: "This device is a subnet router, so it cannot sign in",
        steps: [
          "Traffic it forwards could arrive as this device, so no grant lets it in. Stop advertising routes on it.",
          PAIR_INSTEAD,
        ],
      };
    case "no_grant":
      return {
        headline: `${host} lets in only devices its tailnet policy grants T3 Code`,
        steps: [grant],
      };
    case "grant_unusable":
      return {
        headline: `This device's T3 Code grant on ${host} names no scope T3 Code knows`,
        steps: [
          `In your tailnet policy at ${TAILNET_POLICY_URL}, fix the scopes in that grant. The list takes "read", "standard", "admin", or single scopes such as "orchestration:read".`,
        ],
      };
    case "policy_unknown":
      return {
        headline: `${host} cannot tell whether your tailnet policy grants T3 Code, so it lets in only granted devices`,
        steps: [
          `On ${host}, run \`t3 tailscale require-grant\` to see why. Saved machines retry on their own.`,
          grant,
        ],
      };
    case "blocked":
      return {
        headline: `${host} blocked this device`,
        steps: [
          `On another device with access:write and orchestration:read on ${host} (one paired with a default t3 pair code, one granted admin, or yours while nothing is granted), open Settings > Environments and unblock this device.`,
          `Or run \`t3 pair\` on ${host}, pair this device with the code, and unblock it. Then, on ${host}, revoke that pairing (\`t3 auth session list\`, then \`t3 auth session revoke <id>\`) so it signs in through Tailscale again.`,
        ],
      };
    case "rate_limited":
      return {
        headline: `${host} asked this device to slow down`,
        steps: ["Wait a minute, then try again. Saved machines retry on their own."],
      };
  }
}
