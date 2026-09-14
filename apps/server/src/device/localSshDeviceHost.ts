import * as NodeDnsPromises from "node:dns/promises";
import * as NodeNet from "node:net";
import type { SshDeviceHostConfig } from "@t3tools/contracts";
import * as NodeOS from "node:os";
import * as Context from "effect/Context";
import { runSshCommand } from "@t3tools/ssh/command";
import * as Effect from "effect/Effect";

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

/** Resolve aliases on the owning environment without opening an SSH connection. */
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
    : yield* Effect.tryPromise(() => NodeDnsPromises.lookup(hostname, { all: true })).pipe(
        Effect.map((entries) => entries.map((entry) => entry.address)),
        Effect.timeout("2 seconds"),
        Effect.orElseSucceed(() => [] as string[]),
      );
  const localAddresses = yield* LocalDeviceHostAddresses;
  return (
    addresses.length > 0 &&
    addresses.every(
      (address) => localAddresses.has(address) || address === "::1" || address.startsWith("127."),
    )
  );
});

export const remoteSshDeviceHosts = Effect.fn("remoteSshDeviceHosts")(function* (
  hosts: ReadonlyArray<SshDeviceHostConfig>,
) {
  return yield* Effect.filter(
    hosts,
    (host) => isLocalSshDeviceHost(host).pipe(Effect.map((local) => !local)),
    { concurrency: 4 },
  );
});
