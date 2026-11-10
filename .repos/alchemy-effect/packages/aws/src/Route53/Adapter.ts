import {
  addressRecords,
  adapterLayer,
  isHostnameTarget,
  type DnsAdapter,
  type DnsConfig,
  type DnsHostnameTarget,
  type DnsRecord,
} from "alchemy/DNS/Adapter";
import type { Input } from "alchemy/Input";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";
import type { Providers } from "../Providers.ts";
import { Record } from "./Record.ts";
import { RecordList } from "./RecordList.ts";
import { Records } from "./Records.ts";

/** The {@link DnsConfig.type} of the Route 53 DNS adapter. */
export const ROUTE53_DNS = "AWS.Route53";

/** TTL of CNAMEs to non-AWS targets. */
const CNAME_TTL = "300 seconds";

export interface AdapterOptions {
  /**
   * Hosted zone that owns the records. Inferred per hostname (the most
   * specific public hosted zone in the account) when omitted.
   */
  readonly hostedZoneId?: Input<string>;
}

/**
 * Publish a custom domain's DNS records in Route 53 — the default for AWS
 * composites when `domain.dns` is omitted, and usable from any other
 * platform (a Cloudflare Worker through Cloudflare for SaaS, a Fly or
 * Railway site, …).
 *
 * AWS targets get `A` alias records (plus `AAAA` where the target serves
 * IPv6); other hostname targets get a `CNAME`; address targets get
 * `A`/`AAAA` records. Requires `AWS.providers()` in the stack. See
 * [DNS Adapters](/infrastructure-as-code/dns-adapters).
 *
 * **Example:** Fly site on a Route 53 domain
 * ```typescript
 * yield* Fly.Website.Vite("Web", {
 *   domain: {
 *     name: "app.example.com",
 *     dns: AWS.Route53.Adapter({ hostedZoneId: "Z1234567890" }),
 *   },
 * });
 * ```
 */
export const Adapter = (options: AdapterOptions = {}): DnsConfig<typeof ROUTE53_DNS> => ({
  type: ROUTE53_DNS,
  ...(options.hostedZoneId === undefined ? {} : { zone: options.hostedZoneId }),
});

const aliasTargetOf = (target: DnsHostnameTarget) => ({
  hostedZoneId: target.route53Alias!.hostedZoneId,
  dnsName: target.hostname,
  ...(target.route53Alias!.evaluateTargetHealth === undefined
    ? {}
    : { evaluateTargetHealth: target.route53Alias!.evaluateTargetHealth }),
});

/**
 * The Route 53 DNS adapter, registered by `AWS.providers()`. Logical ids and
 * props match the records AWS composites declared before DNS adapters
 * existed, so upgrading plans no changes:
 *
 * - `alias` — `AWS.Route53.Record` `id` (a lone `A` alias or `CNAME`), or
 *   `id-A` / `id-AAAA` for a dual-stack alias; `id-Addresses`
 *   (`AWS.Route53.RecordList`) for an address target.
 * - `aliasSet` — `AWS.Route53.Records` `id`.
 * - `records` — `AWS.Route53.RecordList` `id`.
 *
 * `hostedZoneId` is always passed (even `undefined`), exactly as before.
 */
export const adapter = {
  alias: (id, { zone: hostedZoneId, name, target, ipv6 }) =>
    !isHostnameTarget(target)
      ? RecordList(`${id}-Addresses`, {
          hostedZoneId,
          records: addressRecords(name, target.ipv4, target.ipv6) as DnsRecord[],
        })
      : target.route53Alias === undefined
        ? Record(id, {
            hostedZoneId,
            name,
            type: "CNAME",
            ttl: CNAME_TTL,
            records: [target.hostname as string],
          })
        : Effect.forEach(ipv6 ? (["A", "AAAA"] as const) : (["A"] as const), (type) =>
            Record(ipv6 ? `${id}-${type}` : id, {
              hostedZoneId,
              name,
              type,
              aliasTarget: aliasTargetOf(target),
            }),
          ),
  aliasSet: (id, { zone: hostedZoneId, names, target }) =>
    Records(id, {
      hostedZoneId,
      ...(names === undefined ? {} : { names }),
      ...(target.route53Alias === undefined
        ? {
            type: "CNAME" as const,
            ttl: CNAME_TTL,
            records: [target.hostname as string],
          }
        : { type: "A" as const, aliasTarget: aliasTargetOf(target) }),
    }),
  records: (id, { zone: hostedZoneId, records, retain }) =>
    RecordList(id, { hostedZoneId, records: records as DnsRecord[] }).pipe(
      retain === true ? RemovalPolicy.retain() : (effect) => effect,
    ),
} satisfies DnsAdapter<Providers>;

export const AdapterLive = adapterLayer(ROUTE53_DNS, adapter);
