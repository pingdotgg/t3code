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

// MagicDNS answers reverse lookups for tailnet addresses through the system resolver.
const lookupTailnetName = Effect.gen(function* () {
  const address = Object.values(NodeOS.networkInterfaces())
    .flatMap((addresses) => addresses ?? [])
    .find(
      (entry) =>
        !entry.internal && entry.family === "IPv4" && isTailscaleIpv4Address(entry.address),
    )?.address;
  if (address === undefined) return null;
  return yield* Effect.promise(() =>
    NodeDns.promises.lookupService(address, 0).then(
      ({ hostname }) => {
        const name = hostname.trim().replace(/\.$/u, "");
        return name.includes(".") && NodeNet.isIP(name) === 0 ? name : null;
      },
      () => null,
    ),
  ).pipe(Effect.timeoutOption(TAILNET_NAME_LOOKUP_TIMEOUT), Effect.map(Option.getOrNull));
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
  // On macOS the CLI runs from the Tailscale app bundle, and macOS can ask the user to let
  // T3 Code access another app's data on every spawn, so connect-time discovery avoids it.
  const avoidTailscaleCli = (yield* HostProcess.Platform) === "darwin";

  const discoverTargets = Effect.gen(function* () {
    // Check both loopback families: sshd can be bound IPv6-only.
    const sshdListening = yield* Effect.zipWith(
      net.hasListenerOnHost(SSH_PORT, "127.0.0.1"),
      net.hasListenerOnHost(SSH_PORT, "::1"),
      (ipv4, ipv6) => ipv4 || ipv6,
    );
    const username = yield* HostProcess.Username;

    const magicDnsName = avoidTailscaleCli
      ? yield* lookupTailnetName
      : yield* readTailscaleStatus.pipe(
          Effect.map((status) => status.magicDnsName),
          Effect.orElseSucceed(() => null),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );

    const targets: Array<RemoteOpenTarget> = [];

    if (!sshdListening) {
      // Tailscale SSH needs no local sshd; tailscaled alone does not prove an SSH route.
      // Only `tailscale debug prefs` proves it, so macOS skips this target.
      if (
        magicDnsName !== null &&
        !avoidTailscaleCli &&
        (yield* readTailscaleSshEnabled.pipe(
          Effect.orElseSucceed(() => false),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ))
      ) {
        targets.push({
          kind: "tailscale",
          host: magicDnsName,
          ...(username === null ? {} : { username }),
        });
      }
      return targets;
    }

    if (magicDnsName !== null) {
      targets.push({
        kind: "tailscale",
        host: magicDnsName,
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
