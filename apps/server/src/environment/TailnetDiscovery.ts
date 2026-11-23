import * as HostProcess from "@t3tools/shared/HostProcess";
import { isTailscaleIpv4Address, readTailscaleStatus } from "@t3tools/tailscale";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as NodeDns from "node:dns";
import * as NodeOS from "node:os";

const TAILNET_NAME_LOOKUP_TIMEOUT = "1500 millis";
// Only the open-source tailscaled creates this; its CLI is not in an app bundle.
const OPEN_SOURCE_TAILSCALED_SOCKET = "/var/run/tailscaled.socket";

export interface Tailnet {
  readonly magicDnsName: string;
  readonly ipv4Addresses: ReadonlyArray<string>;
  /** Only the CLI can report Tailscale SSH; the macOS apps cannot run it anyway. */
  readonly fromCli: boolean;
}

// Other VPNs also use the CGNAT range, so only an address whose reverse lookup returns a
// MagicDNS name (always under ts.net) is treated as this host's tailnet address.
const lookupMagicDnsName = (address: string) =>
  Effect.promise(() =>
    NodeDns.promises.lookupService(address, 0).then(
      ({ hostname }) => {
        const name = hostname.trim().replace(/\.$/u, "").toLowerCase();
        return name.endsWith(".ts.net") ? name : null;
      },
      () => null,
    ),
  ).pipe(Effect.timeoutOption(TAILNET_NAME_LOOKUP_TIMEOUT), Effect.map(Option.getOrNull));

const readTailnetFromInterfaces = Effect.gen(function* () {
  const candidates = Object.values(NodeOS.networkInterfaces())
    .flatMap((addresses) => addresses ?? [])
    .filter(
      (entry) =>
        !entry.internal && entry.family === "IPv4" && isTailscaleIpv4Address(entry.address),
    )
    .map((entry) => entry.address);
  const names = yield* Effect.forEach(candidates, lookupMagicDnsName, {
    concurrency: "unbounded",
  });
  const index = names.findIndex((name) => name !== null);
  const magicDnsName = names[index];
  const address = candidates[index];
  return magicDnsName == null || address === undefined
    ? null
    : { magicDnsName, ipv4Addresses: [address], fromCli: false };
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
