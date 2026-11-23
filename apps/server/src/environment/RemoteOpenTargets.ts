import { type RemoteOpenTarget } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import {
  isTailscaleIpv4Address,
  readTailscaleSshEnabled,
  readTailscaleStatus,
} from "@t3tools/tailscale";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as NodeDns from "node:dns";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";

import { makeStaleWhileRevalidate } from "./staleWhileRevalidate.ts";

const SSH_PORT = 22;
const TARGETS_CACHE_TTL = "60 seconds";
const TAILNET_NAME_LOOKUP_TIMEOUT = "1500 millis";
// Only the open-source tailscaled creates this; its CLI is not in an app bundle.
const OPEN_SOURCE_TAILSCALED_SOCKET = "/var/run/tailscaled.socket";

interface Tailnet {
  readonly magicDnsName: string;
  readonly ipv4Addresses: ReadonlyArray<string>;
}

// MagicDNS answers reverse lookups for tailnet addresses. Other VPNs also use the CGNAT
// range, so an address without a MagicDNS name is not treated as a tailnet address.
const lookupTailnetFromInterfaces = Effect.gen(function* () {
  const address = Object.values(NodeOS.networkInterfaces())
    .flatMap((addresses) => addresses ?? [])
    .find(
      (entry) =>
        !entry.internal && entry.family === "IPv4" && isTailscaleIpv4Address(entry.address),
    )?.address;
  if (address === undefined) return null;
  const magicDnsName = yield* Effect.promise(() =>
    NodeDns.promises.lookupService(address, 0).then(
      ({ hostname }) => {
        const name = hostname.trim().replace(/\.$/u, "");
        return name.includes(".") && NodeNet.isIP(name) === 0 ? name : null;
      },
      () => null,
    ),
  ).pipe(Effect.timeoutOption(TAILNET_NAME_LOOKUP_TIMEOUT), Effect.map(Option.getOrNull));
  return magicDnsName === null ? null : { magicDnsName, ipv4Addresses: [address] };
});

export class RemoteOpenTargets extends Context.Service<
  RemoteOpenTargets,
  {
    readonly resolveTargets: () => Effect.Effect<ReadonlyArray<RemoteOpenTarget>>;
  }
>()("t3/environment/RemoteOpenTargets") {}

/** @public */
export const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const net = yield* NetService.NetService;
  const fileSystem = yield* FileSystem.FileSystem;
  const isMacOS = (yield* HostProcess.Platform) === "darwin";

  const readTailnetFromCli = readTailscaleStatus.pipe(
    Effect.map((status): Tailnet | null =>
      status.running === false || status.magicDnsName === null
        ? null
        : { magicDnsName: status.magicDnsName, ipv4Addresses: status.tailnetIpv4Addresses },
    ),
    Effect.orElseSucceed(() => null),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
  );

  const discoverTargets = Effect.gen(function* () {
    // Check both loopback families: sshd can be bound IPv6-only.
    const sshdListening = yield* Effect.zipWith(
      net.hasListenerOnHost(SSH_PORT, "127.0.0.1"),
      net.hasListenerOnHost(SSH_PORT, "::1"),
      (ipv4, ipv6) => ipv4 || ipv6,
    );
    const username = yield* HostProcess.Username;

    // The macOS Tailscale apps run the CLI from their app bundle, and macOS can ask the user
    // to let T3 Code access another app's data on every spawn, so connect-time discovery avoids it.
    const avoidTailscaleCli =
      isMacOS &&
      !(yield* fileSystem
        .exists(OPEN_SOURCE_TAILSCALED_SOCKET)
        .pipe(Effect.orElseSucceed(() => false)));
    const tailnet = avoidTailscaleCli
      ? yield* lookupTailnetFromInterfaces
      : yield* readTailnetFromCli;

    const targets: Array<RemoteOpenTarget> = [];

    if (!sshdListening) {
      // sshd may listen only on the tailnet address (ListenAddress), and Tailscale SSH
      // needs no local sshd; tailscaled alone does not prove an SSH route.
      if (tailnet === null) return targets;
      const tailnetSshdListening = yield* Effect.forEach(tailnet.ipv4Addresses, (address) =>
        net.hasListenerOnHost(SSH_PORT, address),
      ).pipe(Effect.map((listening) => listening.includes(true)));
      // Only `tailscale debug prefs` proves Tailscale SSH; the macOS apps cannot run an SSH server.
      const sshRoute =
        tailnetSshdListening ||
        (!avoidTailscaleCli &&
          (yield* readTailscaleSshEnabled.pipe(
            Effect.orElseSucceed(() => false),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          )));
      if (sshRoute) {
        targets.push({
          kind: "tailscale",
          host: tailnet.magicDnsName,
          ...(username === null ? {} : { username }),
        });
      }
      return targets;
    }

    if (tailnet !== null) {
      targets.push({
        kind: "tailscale",
        host: tailnet.magicDnsName,
        ...(username === null ? {} : { username }),
      });
    }

    // hostname() may be an FQDN; mDNS always uses <first-label>.local.
    const hostname = yield* HostProcess.Hostname;
    const shortHostname = hostname.split(".")[0]?.trim();
    if (shortHostname !== undefined && shortHostname.length > 0) {
      targets.push({
        kind: "mdns",
        host: `${shortHostname}.local`,
        ...(username === null ? {} : { username }),
      });
    }

    return targets;
  });

  // Advertised on every client connect; probing sshd and tailscaled is slow
  // on a loaded host, so serve the last result while it refreshes.
  const resolveTargets = yield* makeStaleWhileRevalidate(discoverTargets, TARGETS_CACHE_TTL);

  return RemoteOpenTargets.of({
    resolveTargets: Effect.fn("RemoteOpenTargets.resolveTargets")(function () {
      return resolveTargets;
    }),
  });
});

export const layer = Layer.effect(RemoteOpenTargets, make);
