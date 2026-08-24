import * as dns from "@distilled.cloud/cloudflare/dns";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { type DnsAuth, makeHttpDnsBinding } from "./DnsHttp.ts";
import { WriteDns, type WriteDnsClient } from "./WriteDns.ts";

/** Runtime layer for {@link WriteDns}. */
export const WriteDnsHttp = Layer.effect(
  WriteDns,
  Effect.suspend(() =>
    makeHttpDnsBinding({
      permissionGroups: ["DNS Write"],
      makeClient: dnsWriteClient,
    }),
  ),
);

/** Build the write client over an injectable auth and zone id. */
export const dnsWriteClient = (
  auth: DnsAuth,
  zoneId: Effect.Effect<string>,
): WriteDnsClient => {
  const authorize = auth.authorize;
  return {
    createDnsRecord: Effect.fn("Cloudflare.DNS.createDnsRecord")(
      function* (request) {
        return yield* authorize(
          dns.createRecord({ zoneId: yield* zoneId, ...request }),
        );
      },
    ),
    updateDnsRecord: Effect.fn("Cloudflare.DNS.updateDnsRecord")(
      function* (dnsRecordId, request) {
        return yield* authorize(
          dns.updateRecord({ zoneId: yield* zoneId, dnsRecordId, ...request }),
        );
      },
    ),
    patchDnsRecord: Effect.fn("Cloudflare.DNS.patchDnsRecord")(
      function* (dnsRecordId, request) {
        return yield* authorize(
          dns.patchRecord({ zoneId: yield* zoneId, dnsRecordId, ...request }),
        );
      },
    ),
    deleteDnsRecord: Effect.fn("Cloudflare.DNS.deleteDnsRecord")(
      function* (dnsRecordId) {
        return yield* authorize(
          dns.deleteRecord({ zoneId: yield* zoneId, dnsRecordId }),
        );
      },
    ),
    batchDnsRecords: Effect.fn("Cloudflare.DNS.batchDnsRecords")(
      function* (request) {
        return yield* authorize(
          dns.batchRecord({ zoneId: yield* zoneId, ...request }),
        );
      },
    ),
  };
};
