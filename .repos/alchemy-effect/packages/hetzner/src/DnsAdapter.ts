import {
  addressRecords,
  DnsAdapterError,
  adapterLayer,
  isHostnameTarget,
  normalizeDnsName,
  type DnsAdapter,
  type DnsConfig,
  type DnsRecord,
} from "alchemy/DNS/Adapter";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";
import { RecordList } from "./DnsRecordList.ts";
import type { Providers } from "./Providers.ts";

/** The {@link DnsConfig.type} of the Hetzner DNS adapter. */
export const HETZNER_DNS = "Hetzner.DNS";

export interface AdapterOptions {
  /**
   * Zone that owns the records: a zone id, a zone name, or a
   * `Hetzner.Zone` resource. Inferred from each hostname when omitted.
   */
  readonly zone?: Input<string> | { readonly zoneId: Input<number>; readonly name?: Input<string> };
}

/**
 * Publish a custom domain's DNS records in a Hetzner DNS zone — the default
 * for `Hetzner.Website.*`, and usable from any other platform (an AWS site,
 * a Fly or Railway site, a Cloudflare Worker through Cloudflare for SaaS).
 *
 * Hostnames get a `CNAME` (or `A`/`AAAA` records for an address target).
 * Hetzner zones cannot flatten a `CNAME` at the zone apex, so an apex
 * hostname needs an address target. Requires `Hetzner.providers()` in the
 * stack. See [DNS Adapters](/infrastructure-as-code/dns-adapters).
 *
 * **Example:** AWS site on a Hetzner domain
 * ```typescript
 * yield* AWS.Website.StaticSite("Site", {
 *   path: "./dist",
 *   domain: {
 *     name: "www.example.com",
 *     dns: Hetzner.DNS.Adapter({ zone: "example.com" }),
 *   },
 * });
 * ```
 */
export const Adapter = (options: AdapterOptions = {}): DnsConfig<typeof HETZNER_DNS> => {
  const zone =
    options.zone === undefined || typeof options.zone === "string" || Output.isOutput(options.zone)
      ? (options.zone as Input<string> | undefined)
      : (Output.map(
          (options.zone as { zoneId: Input<number> }).zoneId as Output.Output<number>,
          (id) => String(id),
        ) as unknown as Input<string>);
  return {
    type: HETZNER_DNS,
    ...(zone === undefined ? {} : { zone }),
  };
};

/**
 * A Hetzner zone can't hold a CNAME at its apex. Only a zone pinned by name
 * is checkable here — a `Hetzner.Zone` reference is an unresolved Output.
 */
const rejectApexCname = (zone: Input<string> | undefined, name: string) =>
  typeof zone === "string" && normalizeDnsName(name) === normalizeDnsName(zone)
    ? Effect.die(
        new DnsAdapterError({
          message:
            `Hetzner DNS cannot publish a CNAME at the zone apex "${name}". ` +
            "Point the apex at an address target, or use a DNS host that flattens CNAMEs (Cloudflare).",
        }),
      )
    : Effect.void;

/**
 * The Hetzner DNS adapter, registered by `Hetzner.providers()`. Every
 * method declares a `Hetzner.DNS.RecordList`: `alias` → `{id}-CNAME` or
 * `{id}-Addresses`, `aliasSet` → `{id}-CNAME`, `records` → `id`.
 */
export const adapter = {
  alias: (id, { zone, name, target }) =>
    isHostnameTarget(target)
      ? rejectApexCname(zone, name).pipe(
          Effect.andThen(
            RecordList(`${id}-CNAME`, {
              zone,
              names: [name],
              target: target.hostname as string,
            }),
          ),
        )
      : RecordList(`${id}-Addresses`, {
          zone,
          records: addressRecords(name, target.ipv4, target.ipv6) as DnsRecord[],
        }),
  aliasSet: (id, { zone, names, target }) =>
    Effect.forEach(names ?? [], (name) => rejectApexCname(zone, name)).pipe(
      Effect.andThen(
        RecordList(`${id}-CNAME`, {
          zone,
          names,
          target: target.hostname as string,
        }),
      ),
    ),
  records: (id, { zone, records, retain }) =>
    RecordList(id, { zone, records: records as DnsRecord[] }).pipe(
      retain === true ? RemovalPolicy.retain() : (effect) => effect,
    ),
} satisfies DnsAdapter<Providers>;

export const AdapterLive = adapterLayer(HETZNER_DNS, adapter);
