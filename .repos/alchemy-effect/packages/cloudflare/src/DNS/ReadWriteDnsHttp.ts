import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { type DnsAuth, makeHttpDnsBinding } from "./DnsHttp.ts";
import { dnsReadClient } from "./ReadDnsHttp.ts";
import { ReadWriteDns, type ReadWriteDnsClient } from "./ReadWriteDns.ts";
import { dnsWriteClient } from "./WriteDnsHttp.ts";

/** Runtime layer for {@link ReadWriteDns}. */
export const ReadWriteDnsHttp = Layer.effect(
  ReadWriteDns,
  Effect.suspend(() =>
    makeHttpDnsBinding({
      permissionGroups: ["DNS Read", "DNS Write"],
      makeClient: dnsReadWriteClient,
    }),
  ),
);

/** Build the combined read + write client over an injectable auth and zone id. */
export const dnsReadWriteClient = (
  auth: DnsAuth,
  zoneId: Effect.Effect<string>,
): ReadWriteDnsClient => ({
  ...dnsReadClient(auth, zoneId),
  ...dnsWriteClient(auth, zoneId),
});
