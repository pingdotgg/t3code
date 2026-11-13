import * as NodeDnsPromises from "node:dns/promises";
import * as NodeNet from "node:net";
import type { DeviceHostConfig, SshDeviceHostConfig } from "@t3tools/contracts";
import * as NodeOS from "node:os";
import * as Context from "effect/Context";
import { runSshCommand } from "@t3tools/ssh/command";
import * as Effect from "effect/Effect";
import { HostnameLookupError } from "@t3tools/shared/HostProcess";

export const LocalDeviceHostAddresses = Context.Reference<ReadonlySet<string>>(
  "LocalDeviceHostAddresses",
  {
    defaultValue: () =>
      new Set(
        Object.values(NodeOS.networkInterfaces()).flatMap(
          (entries) => entries?.map((entry) => entry.address) ?? [],
        ),
      ),
  },
);

/** Unwraps IPv4-mapped IPv6 (`::ffff:127.0.0.1`, `::ffff:7f00:1`) to plain IPv4. */
const unmapIPv4 = (address: string) => {
  if (NodeNet.isIP(address) !== 6) return address;
  let canonical: string;
  try {
    canonical = new URL(`http://[${address}]`).hostname;
  } catch {
    return address;
  }
  const match = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/.exec(canonical);
  if (!match) return address;
  const [high, low] = [parseInt(match[1]!, 16), parseInt(match[2]!, 16)];
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
};

export const isLocalSshDeviceHost = Effect.fn("isLocalSshDeviceHost")(function* (
  host: SshDeviceHostConfig,
) {
  const result = yield* runSshCommand(
    { alias: host.target, hostname: host.target, username: null, port: host.port ?? null },
    {
      preHostArgs: ["-G", ...(host.identityFile ? ["-i", host.identityFile] : [])],
      timeoutMs: 5000,
    },
  ).pipe(Effect.result);
  if (result._tag === "Failure") return false;
  const config = new Map(
    result.success.stdout.split("\n").map((line) => {
      const separator = line.indexOf(" ");
      return [line.slice(0, separator), line.slice(separator + 1).trim()];
    }),
  );
  // A local forwarded port or a proxy can lead to a different machine.
  if (
    config.get("port") !== "22" ||
    ["proxycommand", "proxyjump"].some((key) => config.has(key) && config.get(key) !== "none")
  )
    return false;
  const hostname = config.get("hostname")?.replace(/^\[|\]$/g, "");
  if (!hostname) return false;
  const addresses = NodeNet.isIP(hostname)
    ? [hostname]
    : yield* Effect.tryPromise({
        try: () => NodeDnsPromises.lookup(hostname, { all: true }),
        catch: (cause) => new HostnameLookupError({ hostname, cause }),
      }).pipe(
        Effect.map((entries) => entries.map((entry) => entry.address)),
        Effect.timeout("2 seconds"),
        Effect.orElseSucceed(() => [] as string[]),
      );
  const localAddresses = yield* LocalDeviceHostAddresses;
  return (
    addresses.length > 0 &&
    addresses
      .map(unmapIPv4)
      .every(
        (address) => localAddresses.has(address) || address === "::1" || address.startsWith("127."),
      )
  );
});

/** Drops SSH hosts that resolve to this machine; other host kinds pass through. */
export const remoteSshDeviceHosts = Effect.fn("remoteSshDeviceHosts")(
  <Host extends DeviceHostConfig>(hosts: ReadonlyArray<Host>) =>
    Effect.filter(
      hosts,
      (host) =>
        host.kind === "ssh"
          ? isLocalSshDeviceHost(host).pipe(Effect.map((local) => !local))
          : Effect.succeed(true),
      { concurrency: 4 },
    ),
);
