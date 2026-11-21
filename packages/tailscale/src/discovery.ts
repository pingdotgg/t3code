import * as HostProcess from "@t3tools/shared/HostProcess";
import { isTailnetHost } from "@t3tools/shared/hostClassification";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as NodeDns from "node:dns";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";

import {
  isTailscaleIpv4Address,
  readTailscaleSshEnabled,
  readTailscaleStatus,
  type TailscaleStatus,
} from "./tailscale.ts";

type NetworkInterfaces = ReturnType<typeof NodeOS.networkInterfaces>;

/** Tailscale's own resolver. It answers only while Tailscale is up, and only for its tailnet. */
const MAGIC_DNS_RESOLVER = "100.100.100.100";
const MAGIC_DNS_TIMEOUT_MS = 1_000;
/** Only the open-source tailscaled makes this; the macOS apps serve their CLI over loopback TCP. */
const TAILSCALED_SOCKET = "/var/run/tailscaled.socket";

// macOS utun names need Tailscale's IPv6 range to identify them; WARP shares its IPv4 range.
export const isTailscaleInterface = (
  name: string,
  entries: ReadonlyArray<NodeOS.NetworkInterfaceInfo>,
): boolean =>
  /^tailscale/i.test(name) ||
  entries.some((entry) => entry.family === "IPv6" && isTailnetHost(entry.address));

const lookupMagicDnsName = (address: string) =>
  Effect.callback<string | null>((resume) => {
    const resolver = new NodeDns.Resolver({ timeout: MAGIC_DNS_TIMEOUT_MS, tries: 1 });
    resolver.setServers([MAGIC_DNS_RESOLVER]);
    resolver.reverse(address, (error, names) => {
      const name = error ? "" : (names[0] ?? "").trim().replace(/\.$/u, "");
      resume(Effect.succeed(name.length > 0 ? name : null));
    });
    return Effect.sync(() => resolver.cancel());
  });

const tailscaledAnswers = Effect.callback<boolean>((resume) => {
  const socket = NodeNet.connect({ path: TAILSCALED_SOCKET });
  socket.once("connect", () => {
    socket.destroy();
    resume(Effect.succeed(true));
  });
  socket.once("error", () => resume(Effect.succeed(false)));
  return Effect.sync(() => socket.destroy());
});

/** What discovery reads from the machine instead of the CLI; a reference so tests can replace it. */
export const TailscaleHost = Context.Reference<{
  readonly networkInterfaces: () => NetworkInterfaces;
  readonly tailscaledAnswers: Effect.Effect<boolean>;
  readonly lookupMagicDnsName: (address: string) => Effect.Effect<string | null>;
}>("@t3tools/tailscale/TailscaleHost", {
  defaultValue: () => ({
    networkInterfaces: () => NodeOS.networkInterfaces(),
    tailscaledAnswers,
    lookupMagicDnsName,
  }),
});

/**
 * The macOS apps keep their CLI in the app bundle, where each run reads the app's own container.
 * macOS reports that as T3 Code asking for another app's data, and asks again on later runs.
 */
const cliIsMacApp = Effect.gen(function* () {
  if ((yield* HostProcess.Platform) !== "darwin") return false;
  return !(yield* (yield* TailscaleHost).tailscaledAnswers);
});

const readStatusWithoutCli = Effect.gen(function* () {
  const host = yield* TailscaleHost;
  const entries = Object.entries(host.networkInterfaces()).flatMap(([name, entries = []]) =>
    isTailscaleInterface(name, entries) ? entries : [],
  );
  const tailnetIpv4Addresses = entries
    .filter((entry) => entry.family === "IPv4" && isTailscaleIpv4Address(entry.address))
    .map((entry) => entry.address);
  // A tailnet can turn IPv4 off, which leaves the interface only its fd7a address.
  const address =
    tailnetIpv4Addresses[0] ?? entries.find((entry) => isTailnetHost(entry.address))?.address;
  const status: TailscaleStatus = {
    // The apps remove their interface when Tailscale disconnects, so its presence means it is up.
    running: entries.length > 0,
    magicDnsName: address === undefined ? null : yield* host.lookupMagicDnsName(address),
    tailnetIpv4Addresses,
    httpsServeEnabled: null,
  };
  return status;
});

/**
 * `readTailscaleStatus` for discovery nobody asked for, such as on every client connect: it starts
 * no process where the CLI is the macOS app's. `httpsServeEnabled` is unknown there.
 */
export const readTailscaleStatusForDiscovery = Effect.flatMap(cliIsMacApp, (macApp) =>
  macApp ? readStatusWithoutCli : readTailscaleStatus,
);

/** `readTailscaleSshEnabled` for the same discovery. The macOS apps cannot serve Tailscale SSH. */
export const readTailscaleSshEnabledForDiscovery = Effect.flatMap(cliIsMacApp, (macApp) =>
  macApp ? Effect.succeed(false) : readTailscaleSshEnabled,
);
