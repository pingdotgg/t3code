import * as NodeDns from "node:dns";
import * as NodeNet from "node:net";

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * Hosts that may receive webhooks although they are private or plain `http:`, for testing
 * against a local receiver. Comma-separated host names or addresses; unset denies them all.
 */
export const ALLOWED_HOSTS_ENV = "T3CODE_MCP_WEBHOOK_ALLOWED_HOSTS";

export const allowedHosts = Config.String(ALLOWED_HOSTS_ENV).pipe(
  Config.withDefault(""),
  Config.map((value) => value.split(",").filter((host) => host.trim() !== "")),
);

export class WebhookAddressRejected extends Schema.TaggedError<WebhookAddressRejected>()(
  "WebhookAddressRejected",
  { message: Schema.String },
) {}

// The IANA special-purpose ranges that are not globally reachable. An IPv6 address must also be
// in global unicast (2000::/3), which leaves out every form that embeds an IPv4 address. Two
// lists, because a list checks an IPv4 address against its IPv4-mapped IPv6 rules too.
const notGlobalV4 = new NodeNet.BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  notGlobalV4.addSubnet(network, prefix, "ipv4");
}
const globalUnicastV6 = new NodeNet.BlockList();
globalUnicastV6.addSubnet("2000::", 3, "ipv6");
const notGlobalV6 = new NodeNet.BlockList();
for (const [network, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const) {
  notGlobalV6.addSubnet(network, prefix, "ipv6");
}

export const isGloballyRoutable = (address: string): boolean => {
  const family = NodeNet.isIP(address);
  if (family === 4) return !notGlobalV4.check(address, "ipv4");
  return (
    family === 6 && globalUnicastV6.check(address, "ipv6") && !notGlobalV6.check(address, "ipv6")
  );
};

const hostOf = (url: URL) => url.hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();

const resolveAll = (host: string) =>
  Effect.callback<ReadonlyArray<NodeDns.LookupAddress>, Error>((resume) => {
    NodeDns.lookup(host, { all: true }, (error, addresses) =>
      resume(error === null ? Effect.succeed(addresses) : Effect.fail(error)),
    );
  });

/**
 * The webhook address check and the client deliveries go through. The client resolves again
 * as it connects, to the address it checks, so DNS rebinding cannot reach a private address;
 * TLS still sees the host name. Undici's dispatcher never follows redirects.
 */
export const make = (hosts: ReadonlyArray<string>) => {
  const allowed = new Set(hosts.map((host) => host.trim().toLowerCase()));
  const check = Effect.fn("McpWebhookTransport.check")(function* (url: URL) {
    const host = hostOf(url);
    if (allowed.has(host)) return;
    const addresses =
      NodeNet.isIP(host) !== 0
        ? [host]
        : (yield* resolveAll(host).pipe(
            // A subscribe holds its slot while this runs, and a delivery's request timeout
            // does not cover it, so a slow resolver counts as no answer.
            Effect.timeout("5 seconds"),
            Effect.mapError(
              () => new WebhookAddressRejected({ message: `${host} could not be resolved` }),
            ),
          )).map((resolved) => resolved.address);
    if (addresses.length === 0 || !addresses.every(isGloballyRoutable)) {
      return yield* new WebhookAddressRejected({ message: `${host} is not a public address` });
    }
  });
  const lookup: NodeNet.LookupFunction = (hostname, lookupOptions, callback) => {
    NodeDns.lookup(hostname, { ...lookupOptions, all: true }, (error, addresses) => {
      if (error !== null) return callback(error, "");
      if (
        !allowed.has(hostname.toLowerCase()) &&
        (addresses.length === 0 ||
          addresses.some((address) => !isGloballyRoutable(address.address)))
      ) {
        return callback(
          Object.assign(new Error(`${hostname} is not a public address`), {
            code: "ECONNREFUSED",
          }),
          "",
        );
      }
      if (lookupOptions.all === true) return callback(null, addresses);
      const [first] = addresses;
      return callback(null, first!.address, first!.family);
    });
  };
  return {
    check,
    allowsPlaintext: (url: URL) => allowed.has(hostOf(url)),
    // The Undici client statically imports undici, which a single-executable cannot load.
    layerClient: NodeHttpClient.layerNodeHttpOptions({ lookup }),
  };
};
