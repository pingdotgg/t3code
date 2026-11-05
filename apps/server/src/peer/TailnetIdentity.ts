import {
  isTailnetAddress,
  readTailnet,
  type Tailnet,
  type TailnetPeer,
  type TailnetWhois,
  whoisTailnetAddress,
} from "@t3tools/tailscale";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as NodeNet from "node:net";

import { DEFAULT_PORT } from "../config.ts";

/** Where a URL reaches on the tailnet, and the address whose owner answers there. */
export interface TailnetTarget {
  readonly origin: string;
  readonly address: string;
}

/**
 * The tailnet address a URL reaches, only when this node can tell which node
 * answers there without trusting DNS: a literal tailnet IP, or an https
 * MagicDNS name of a peer, whose certificate Tailscale issues to that node
 * alone. Plain http on a name, LAN and public addresses are never located.
 */
export const locateTailnetTarget = (url: string, tailnet: Tailnet): TailnetTarget | null => {
  const parsed = URL.parse(url);
  if (parsed === null || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
    return null;
  }
  const host = parsed.hostname.replace(/^\[(.*)\]$/u, "$1").toLowerCase();
  if (NodeNet.isIP(host) !== 0) {
    return isTailnetAddress(host) ? { origin: parsed.origin, address: host } : null;
  }
  if (parsed.protocol !== "https:") return null;
  const peer = tailnet.peers.find((candidate) => candidate.magicDnsName?.toLowerCase() === host);
  const address = peer?.tailnetAddresses[0];
  return address === undefined ? null : { origin: parsed.origin, address };
};

// Phones and TVs never host a T3 server, and each dead probe wakes their tunnel extension.
const NON_HOST_OS = new Set(["ios", "tvos", "android"]);

/** The Serve ports T3 picks, then its own port on the tailnet address. */
export const probeUrlsFor = (peer: TailnetPeer): ReadonlyArray<string> =>
  peer.os !== null && NON_HOST_OS.has(peer.os.toLowerCase())
    ? []
    : [
        ...(peer.magicDnsName === null
          ? []
          : [443, 8443, 3443].map((port) =>
              port === 443
                ? `https://${peer.magicDnsName}`
                : `https://${peer.magicDnsName}:${port}`,
            )),
        ...peer.tailnetAddresses
          .filter((address) => NodeNet.isIPv4(address))
          .map((address) => `http://${address}:${DEFAULT_PORT}`),
      ];

/** What Tailscale says about this node and the others, which the tailnet device handshake trusts. */
export class TailnetIdentity extends Context.Service<
  TailnetIdentity,
  {
    /** This node and its peers, or nothing when Tailscale is not running here. */
    readonly read: Effect.Effect<Option.Option<Tailnet>>;
    readonly locate: (url: string, tailnet: Tailnet) => Option.Option<TailnetTarget>;
    /** Who owns a tailnet address, or nothing when nobody does or Tailscale cannot say. */
    readonly whois: (address: string) => Effect.Effect<Option.Option<TailnetWhois>>;
    /** Where a peer's T3 server may answer. */
    readonly probeUrls: (peer: TailnetPeer) => ReadonlyArray<string>;
  }
>()("t3/peer/TailnetIdentity") {}

export const layer = Layer.effect(
  TailnetIdentity,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return TailnetIdentity.of({
      read: readTailnet.pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.tapError((cause) => Effect.logDebug("Tailscale status unavailable", { cause })),
        Effect.option,
      ),
      locate: (url, tailnet) => Option.fromNullishOr(locateTailnetTarget(url, tailnet)),
      whois: Effect.fn("TailnetIdentity.whois")(
        (address: string) => whoisTailnetAddress(address),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.tapError((cause) => Effect.logDebug("Tailscale whois failed", { cause })),
        Effect.map(Option.fromNullishOr),
        Effect.orElseSucceed(() => Option.none()),
      ),
      probeUrls: probeUrlsFor,
    });
  }),
);
