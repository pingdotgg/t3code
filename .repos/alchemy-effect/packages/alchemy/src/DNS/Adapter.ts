/**
 * Pluggable DNS for custom domains.
 *
 * A custom domain has two independent halves: the platform that SERVES the
 * hostname (CloudFront, an ALB, API Gateway, a Worker, a Fly App, …) and the
 * DNS host that PUBLISHES its records (Route 53, Cloudflare, Hetzner DNS, …).
 * `domain.dns` names the DNS host.
 *
 * The prop value is a {@link DnsConfig}: plain, serializable data
 * (`{ type: "Cloudflare.DNS", zone?, options? }`) that is safe in any
 * Resource or Platform prop, in state, and across the `alchemy dev` sidecar.
 * Each DNS host contributes:
 *
 * - a data constructor (`Cloudflare.DNS.Adapter()`,
 *   `AWS.Route53.Adapter()`, `Hetzner.DNS.Adapter()`), and
 * - a {@link DnsAdapter} — functions that declare its record resources —
 *   registered with {@link adapterLayer} from its own `providers()` layer.
 *
 * A composite (or a Platform's `transformProps` hook) resolves the adapter
 * with {@link resolve} while the stack program is being built, and the
 * adapter DECLARES ordinary record resources of its own cloud. No
 * reconciler ever calls an adapter, so destroy and orphan cleanup work from
 * state alone, and the platform packages never import each other.
 */
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { Input } from "../Input.ts";
import * as Output from "../Output.ts";
import type { Resource, ResourceLike } from "../Resource.ts";

/**
 * Which DNS host publishes a custom domain's records. Returned by a DNS
 * host's adapter constructor, e.g. `Cloudflare.DNS.Adapter()`.
 */
export interface DnsConfig<Type extends string = string> {
  /**
   * The adapter implementation to resolve (e.g. `"Cloudflare.DNS"`,
   * `"AWS.Route53"`, `"Hetzner.DNS"`). Registered by the DNS host's
   * `providers()` layer.
   */
  readonly type: Type;
  /**
   * The zone that owns the records, interpreted by the DNS host: a
   * Cloudflare zone id or name, a Route 53 hosted zone id, a Hetzner zone
   * id or name. Inferred from each hostname when omitted.
   */
  readonly zone?: Input<string> | undefined;
  /**
   * Host-specific options, e.g. `{ proxied: true }` for Cloudflare.
   */
  readonly options?: { readonly [key: string]: unknown } | undefined;
}

/** Record types a DNS adapter publishes. */
export type DnsRecordType = "A" | "AAAA" | "CNAME" | "TXT";

/**
 * One record to publish — typically computed from another resource's
 * outputs (ACM validation CNAMEs, a platform's ownership TXT, …).
 */
export interface DnsRecord {
  /** Fully qualified record name (a trailing dot is ignored). */
  name: string;
  /** Record type. */
  type: DnsRecordType;
  /** Record value (a trailing dot on hostnames is ignored). */
  value: string;
  /**
   * TTL in seconds. Hosts with an "automatic" setting use it when omitted.
   */
  ttl?: number;
}

/**
 * A hostname target: a CNAME to `hostname`, or — on Route 53 — an alias
 * record when `route53Alias` is set.
 */
export interface DnsHostnameTarget {
  /** Hostname to point at, e.g. `d123.cloudfront.net`. */
  hostname: Input<string>;
  /**
   * Route 53 alias details of an AWS target (CloudFront, ELB, API
   * Gateway). Used by the Route 53 adapter to write an `A` (+ `AAAA`)
   * alias record; other hosts write a `CNAME` to {@link hostname}.
   */
  route53Alias?: {
    /** Route 53 hosted zone id of the AWS target. */
    hostedZoneId: Input<string>;
    /** Route 53 alias `EvaluateTargetHealth`. */
    evaluateTargetHealth?: boolean;
  };
}

/** An address target: `A` / `AAAA` records. */
export interface DnsAddressTarget {
  /** IPv4 addresses (`A` records). */
  ipv4?: Input<string[]>;
  /** IPv6 addresses (`AAAA` records). */
  ipv6?: Input<string[]>;
}

/**
 * Where an alias hostname points. The target's KIND (hostname vs.
 * addresses) must be known while the program is built; its values may be
 * Outputs.
 */
export type DnsAliasTarget = DnsHostnameTarget | DnsAddressTarget;

/** Whether a target is a hostname (CNAME / Route 53 alias) target. */
export const isHostnameTarget = (target: DnsAliasTarget): target is DnsHostnameTarget =>
  "hostname" in target && target.hostname !== undefined;

/** Binding contract of an {@link DnsAdapter.aliasSet} record set. */
export type DnsAliasSetBinding = {
  /** Additional hostnames pointed at the set's target. */
  names?: string[];
};

/**
 * A record set other composites bind hostnames onto via `{ names }` (see
 * `AWS.Website.Router`'s `bindTargets.records`).
 */
export type DnsAliasSet = ResourceLike<string, any, any, DnsAliasSetBinding, any> &
  Pick<Resource<string, any, any, DnsAliasSetBinding, any>, "bind">;

/**
 * A DNS host cannot publish the requested records, e.g. a `CNAME` at a zone
 * apex on a host without CNAME flattening. Raised (as a defect, like any
 * other invalid configuration) while the stack program is being built,
 * before anything is deployed.
 */
export class DnsAdapterError extends Data.TaggedError("DnsAdapterError")<{
  readonly message: string;
}> {}

/**
 * `domain.dns` names a DNS host whose adapter is not registered: the host's
 * `providers()` layer is missing from the stack. Raised as a defect while
 * the stack program is being built, like a missing resource provider.
 */
export class DnsAdapterNotRegistered extends Data.TaggedError("DnsAdapterNotRegistered")<{
  readonly type: string;
}> {
  override get message() {
    const provider = this.type.split(".")[0];
    return (
      `No DNS adapter is registered for "${this.type}". ` +
      `Add ${provider}.providers() to the stack's providers layer.`
    );
  }
}

/**
 * Where an adapter method writes: the zone and host-specific options from
 * the user's {@link DnsConfig}. {@link resolve} fills these in, so callers
 * never pass them.
 */
export interface DnsZone {
  /** Zone id or name (Route 53: hosted zone id). Inferred per hostname when omitted. */
  zone?: Input<string> | undefined;
  /** Host-specific options from the adapter constructor, e.g. `{ proxied: true }`. */
  options?: { readonly [key: string]: unknown };
}

/**
 * A DNS adapter: functions that declare a DNS host's record resources. They
 * perform no I/O — composites call them while the stack program is built —
 * so they behave the same under `alchemy deploy`, `alchemy dev`, and tests.
 *
 * `R` is the host's provider requirement (e.g. `Cloudflare.Providers`):
 * return the resource constructors' Effects as they are.
 */
export interface DnsAdapter<R = never> {
  /**
   * Point one hostname at `target`. `ipv6` also publishes IPv6 for a
   * hostname target where the host needs a separate record (Route 53
   * `AAAA` alias); a CNAME already covers both.
   */
  alias(
    id: string,
    args: DnsZone & { name: string; target: DnsAliasTarget; ipv6?: boolean },
  ): Effect.Effect<unknown, never, R>;
  /**
   * A (possibly empty) set of hostnames pointed at a hostname target that
   * other composites extend by binding `{ names }` onto it (used by
   * `AWS.Website.Router`, whose attached sites add their hostnames).
   */
  aliasSet(
    id: string,
    args: DnsZone & { names?: string[]; target: DnsHostnameTarget },
  ): Effect.Effect<DnsAliasSet, never, R>;
  /**
   * Publish explicit records whose values come from another resource
   * (certificate validation, ownership verification). Records are always
   * DNS-only (never proxied). `retain` keeps them when the resource is
   * destroyed — used for ACM validation CNAMEs, which ACM reuses across
   * every certificate for a name.
   */
  records(
    id: string,
    args: DnsZone & { records: Input<DnsRecord[]>; retain?: boolean },
  ): Effect.Effect<unknown, never, R>;
}

const adapterService = (type: string) =>
  Context.Service<DnsAdapter<any>>(`alchemy/DNS/Adapter/${type}`);

/**
 * Register a DNS adapter under the {@link DnsConfig.type} its constructor
 * returns. Merge the layer into the DNS host's `providers()` layer, which
 * also registers the providers of the resources the adapter declares.
 */
export const adapterLayer = <R>(
  type: string,
  adapter: DnsAdapter<R>,
): Layer.Layer<DnsAdapter<any>> => Layer.succeed(adapterService(type), adapter);

/**
 * Fill in `zone` / `options` from a {@link DnsConfig} on every call.
 */
export const bind = <R>(adapter: DnsAdapter<R>, config: DnsConfig): DnsAdapter<R> => {
  const zone: DnsZone = {
    ...(config.zone === undefined ? {} : { zone: config.zone }),
    ...(config.options === undefined ? {} : { options: config.options }),
  };
  return {
    alias: (id, args) => adapter.alias(id, { ...zone, ...args }),
    aliasSet: (id, args) => adapter.aliasSet(id, { ...zone, ...args }),
    records: (id, args) => adapter.records(id, { ...zone, ...args }),
  };
};

/**
 * The adapter registered for `config.type`, with `config`'s zone and
 * options filled in. Dies with {@link DnsAdapterNotRegistered} when the DNS
 * host's `providers()` layer is not part of the stack.
 *
 * `domain.dns` picks the host by a runtime string, so the host's provider
 * requirement can't be named statically here and the returned adapter is
 * typed without it. That is safe: the requirement is type-level only
 * (declaring a resource never reads its provider), and the adapter is only
 * registered by the host's `providers()` layer, which also registers the
 * providers of the resources it declares.
 */
export const resolve = (config: DnsConfig): Effect.Effect<DnsAdapter> =>
  Effect.serviceOption(adapterService(config.type)).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.die(new DnsAdapterNotRegistered({ type: config.type })),
        onSome: (adapter) => Effect.succeed(bind(adapter as DnsAdapter, config)),
      }),
    ),
  );

/** Normalize a DNS name: lowercase, no trailing dot. */
export const normalizeDnsName = (name: string) => name.replace(/\.$/, "").toLowerCase();

/** `A` / `AAAA` records for an address target (values may be Outputs). */
export const addressRecords = (
  name: string,
  ipv4: Input<string[]> | undefined,
  ipv6: Input<string[]> | undefined,
): Input<DnsRecord[]> => {
  const toRecords = (v4: string[], v6: string[]): DnsRecord[] => [
    ...v4.map((value) => ({ name, type: "A" as const, value })),
    ...v6.map((value) => ({ name, type: "AAAA" as const, value })),
  ];
  if (!Output.isOutput(ipv4) && !Output.isOutput(ipv6)) {
    return toRecords((ipv4 ?? []) as string[], (ipv6 ?? []) as string[]);
  }
  const lift = (value: Input<string[]> | undefined): any =>
    Output.isOutput(value) ? value : Output.literal((value ?? []) as string[]);
  return Output.map(Output.all(lift(ipv4) as any, lift(ipv6) as any), ([v4, v6]: any) =>
    toRecords(v4 as string[], v6 as string[]),
  ) as unknown as Input<DnsRecord[]>;
};

/**
 * The records that point `name` at `target`: a `CNAME` to a hostname
 * target, or `A` / `AAAA` records for an address target. A convenience for
 * adapters whose `alias` publishes through a list-of-records resource.
 */
export const aliasRecords = (name: string, target: DnsAliasTarget): Input<DnsRecord[]> =>
  isHostnameTarget(target)
    ? [{ name, type: "CNAME", value: target.hostname as string }]
    : addressRecords(name, target.ipv4, target.ipv6);
