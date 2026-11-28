import * as HostProcess from "@t3tools/shared/HostProcess";
import { isTailnetHost } from "@t3tools/shared/hostClassification";
import { isTailscaleIpv4Address, readTailscaleStatus } from "@t3tools/tailscale";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as NodeDns from "node:dns";
import * as NodeOS from "node:os";

const TAILNET_NAME_LOOKUP_TIMEOUT = "1500 millis";
const TAILSCALE_RESOLVER = "100.100.100.100";
// Only the open-source tailscaled creates this; its CLI is not in an app bundle.
const OPEN_SOURCE_TAILSCALED_SOCKET = "/var/run/tailscaled.socket";

export interface Tailnet {
  readonly magicDnsName: string;
  readonly ipv4Addresses: ReadonlyArray<string>;
  /** Only the CLI can report Tailscale SSH; the macOS apps cannot run it anyway. */
  readonly fromCli: boolean;
}

// Tailscale's resolver answers for any tailnet node, so only an address on a local Tailscale
// interface is asked about, and only a MagicDNS name (always under ts.net) is accepted.
// Ask the resolver directly: it answers even when the Mac does not use Tailscale's DNS settings.
const lookupMagicDnsName = (address: string) =>
  Effect.promise(() => {
    const resolver = new NodeDns.promises.Resolver({ tries: 1 });
    resolver.setServers([TAILSCALE_RESOLVER]);
    return resolver.reverse(address).then(
      (names) =>
        names
          .map((name) => name.trim().replace(/\.$/u, "").toLowerCase())
          .find((name) => name.endsWith(".ts.net")) ?? null,
      () => null,
    );
  }).pipe(Effect.timeoutOption(TAILNET_NAME_LOOKUP_TIMEOUT), Effect.map(Option.getOrNull));

// macOS utun names need Tailscale's IPv6 range to identify them; other VPNs share its IPv4 range.
export const isTailscaleInterface = (
  name: string,
  entries: ReadonlyArray<NodeOS.NetworkInterfaceInfo>,
): boolean =>
  /^tailscale/i.test(name) ||
  entries.some((entry) => entry.family === "IPv6" && isTailnetHost(entry.address));

const readTailnetFromInterfaces = Effect.gen(function* () {
  const entries = Object.entries(NodeOS.networkInterfaces())
    .flatMap(([name, entries = []]) => (isTailscaleInterface(name, entries) ? entries : []))
    .filter((entry) => !entry.internal);
  const ipv4 = entries.find(
    (entry) => entry.family === "IPv4" && isTailscaleIpv4Address(entry.address),
  )?.address;
  // A tailnet can disable IPv4; its MagicDNS name still resolves from the IPv6 address.
  const address =
    ipv4 ??
    entries.find((entry) => entry.family === "IPv6" && isTailnetHost(entry.address))?.address;
  if (address === undefined) return null;
  const magicDnsName = yield* lookupMagicDnsName(address);
  return magicDnsName === null
    ? null
    : { magicDnsName, ipv4Addresses: ipv4 === undefined ? [] : [ipv4], fromCli: false };
});

/**
 * Reads this host's tailnet name for passive, per-connect discovery. The macOS Tailscale apps
 * run the CLI from their app bundle, and macOS can ask the user to let T3 Code access another
 * app's data on every spawn, so there it reads interfaces and reverse DNS instead.
 */
export const makeReadTailnet = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const isMacOS = (yield* HostProcess.Platform) === "darwin";

  const readTailnetFromCli = readTailscaleStatus.pipe(
    Effect.map((status): Tailnet | null =>
      status.running === false || status.magicDnsName === null
        ? null
        : {
            magicDnsName: status.magicDnsName,
            ipv4Addresses: status.tailnetIpv4Addresses,
            fromCli: true,
          },
    ),
    Effect.orElseSucceed(() => null),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
  );

  return Effect.gen(function* () {
    const avoidCli =
      isMacOS &&
      !(yield* fileSystem
        .exists(OPEN_SOURCE_TAILSCALED_SOCKET)
        .pipe(Effect.orElseSucceed(() => false)));
    return avoidCli ? yield* readTailnetFromInterfaces : yield* readTailnetFromCli;
  });
});
