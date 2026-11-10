import {
  addressRecords,
  adapterLayer,
  isHostnameTarget,
  type DnsAdapter,
  type DnsConfig,
  type DnsRecord,
} from "alchemy/DNS/Adapter";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import type { Providers } from "../Providers.ts";
import { RecordList } from "./RecordList.ts";
import { Records } from "./Records.ts";

/** The {@link DnsConfig.type} of the Cloudflare DNS adapter. */
export const CLOUDFLARE_DNS = "Cloudflare.DNS";

export interface AdapterOptions {
  /**
   * Zone that owns the records: a zone id, a zone name, or a `Zone`
   * resource. Inferred from each hostname when omitted.
   */
  readonly zone?: Input<string> | { readonly zoneId: Input<string> };
  /**
   * Send alias records through Cloudflare's proxy (orange cloud).
   * Validation and verification records are always DNS-only.
   * @default false
   */
  readonly proxied?: boolean;
}

/**
 * Publish a custom domain's DNS records in a Cloudflare zone — e.g. a
 * domain registered with Cloudflare Registrar that is served by AWS, Fly,
 * Railway, Neon, Prisma, or Hetzner.
 *
 * Pass it as `domain.dns`. The serving platform then publishes its
 * certificate-validation / verification records (always DNS-only) and
 * points each hostname at itself with a `CNAME` (flattened at the zone
 * apex) or `A`/`AAAA` records. Requires `Cloudflare.providers()` in the
 * stack. See [DNS Adapters](/infrastructure-as-code/dns-adapters).
 *
 * **Example:** AWS site on a Cloudflare domain
 * ```typescript
 * yield* AWS.Website.StaticSite("Site", {
 *   path: "./dist",
 *   domain: { name: "www.example.com", dns: Cloudflare.DNS.Adapter() },
 * });
 * ```
 *
 * **Example:** Pinned zone, proxied aliases
 * ```typescript
 * // Proxying CloudFront through Cloudflare: set the zone's SSL/TLS mode
 * // to Full (strict).
 * dns: Cloudflare.DNS.Adapter({ zone: "example.com", proxied: true })
 * ```
 */
export const Adapter = (options: AdapterOptions = {}): DnsConfig<typeof CLOUDFLARE_DNS> => {
  const zone =
    options.zone === undefined || typeof options.zone === "string" || Output.isOutput(options.zone)
      ? (options.zone as Input<string> | undefined)
      : (options.zone as { zoneId: Input<string> }).zoneId;
  return {
    type: CLOUDFLARE_DNS,
    ...(zone === undefined ? {} : { zone }),
    ...(options.proxied === undefined ? {} : { options: { proxied: options.proxied } }),
  };
};

/**
 * The Cloudflare DNS adapter, registered by `Cloudflare.providers()`:
 *
 * - `alias` / `aliasSet` — a `Cloudflare.DNS.Records` CNAME set for a
 *   hostname target (logical id `{id}-CNAME`), or a
 *   `Cloudflare.DNS.RecordList` of `A`/`AAAA` records for an address target
 *   (`{id}-Addresses`).
 * - `records` — a `Cloudflare.DNS.RecordList`.
 */
export const adapter = {
  alias: (id, { zone, options, name, target }) =>
    isHostnameTarget(target)
      ? Records(`${id}-CNAME`, {
          zone,
          ...(options?.proxied === true ? { proxied: true } : {}),
          type: "CNAME",
          content: target.hostname as string,
          names: [name],
        })
      : RecordList(`${id}-Addresses`, {
          zone,
          records: addressRecords(name, target.ipv4, target.ipv6) as DnsRecord[],
        }),
  aliasSet: (id, { zone, options, names, target }) =>
    Records(`${id}-CNAME`, {
      zone,
      ...(options?.proxied === true ? { proxied: true } : {}),
      type: "CNAME",
      content: target.hostname as string,
      names,
    }),
  records: (id, { zone, records, retain }) =>
    RecordList(id, { zone, records: records as DnsRecord[] }).pipe(
      retain === true ? RemovalPolicy.retain() : (effect) => effect,
    ),
} satisfies DnsAdapter<Providers>;

export const AdapterLive = adapterLayer(CLOUDFLARE_DNS, adapter);
