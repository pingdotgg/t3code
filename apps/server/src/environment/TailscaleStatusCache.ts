import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  isTailscaleIpv4Address,
  readTailscaleSshEnabled,
  readTailscaleStatus,
  type TailscaleStatus,
} from "@t3tools/tailscale";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as NodeOS from "node:os";

export class TailscaleStatusCache extends Context.Service<
  TailscaleStatusCache,
  {
    readonly readStatus: () => Effect.Effect<
      TailscaleStatus,
      Effect.Error<typeof readTailscaleStatus>
    >;
    readonly readSshEnabled: () => Effect.Effect<
      boolean,
      Effect.Error<typeof readTailscaleSshEnabled>
    >;
  }
>()("t3/environment/TailscaleStatusCache") {}

const FAILED_READ_TTL = Duration.seconds(60);

const tailnetAddressKey = (): string =>
  [
    ...new Set(
      Object.values(NodeOS.networkInterfaces())
        .flatMap((addresses) => addresses ?? [])
        .filter(
          (address) =>
            !address.internal &&
            address.family === "IPv4" &&
            isTailscaleIpv4Address(address.address),
        )
        .map((address) => address.address),
    ),
  ]
    .toSorted()
    .join(",");

const make = Effect.gen(function* () {
  // Only macOS keeps reads: there each `tailscale` spawn can raise an "access data from other
  // apps" prompt, so a success lives until the tailnet addresses change. Elsewhere every read is fresh.
  const timeToLive =
    (yield* HostProcess.Platform) === "darwin"
      ? (exit: Exit.Exit<unknown, unknown>) =>
          Exit.isSuccess(exit) ? Duration.infinity : FAILED_READ_TTL
      : () => Duration.zero;
  const statusCache = yield* Cache.makeWith((_key: string) => readTailscaleStatus, {
    capacity: 1,
    timeToLive,
  });
  const sshEnabledCache = yield* Cache.makeWith((_key: string) => readTailscaleSshEnabled, {
    capacity: 1,
    timeToLive,
  });

  return TailscaleStatusCache.of({
    readStatus: Effect.fn("TailscaleStatusCache.readStatus")(function () {
      return Cache.get(statusCache, tailnetAddressKey());
    }),
    readSshEnabled: Effect.fn("TailscaleStatusCache.readSshEnabled")(function () {
      return Cache.get(sshEnabledCache, tailnetAddressKey());
    }),
  });
});

export const layer = Layer.effect(TailscaleStatusCache, make);
