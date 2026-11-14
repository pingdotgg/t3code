import * as DNS from "alchemy/DNS/Adapter";
import type { Input } from "alchemy/Input";
import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import { defaultProviderMode } from "alchemy/ProviderMode";
/**
 * `Cloudflare.Worker` custom domains whose DNS lives outside Cloudflare
 * (Route 53, Hetzner DNS, …), served through Cloudflare for SaaS.
 *
 * A native Worker custom domain only works for a hostname in a Cloudflare
 * zone of the account. For any other DNS host, each hostname becomes a
 * `Cloudflare.CustomHostname.CustomHostname` on a Cloudflare zone the user
 * owns (the "SaaS zone"), the DNS host publishes the ownership and
 * certificate-validation TXT records plus a CNAME to the SaaS zone, and a
 * Worker route on the SaaS zone serves the traffic.
 *
 * Composition happens in the Worker's `transformProps` hook, at construct
 * time: the WorkerProvider never sees `domain.dns`.
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import {
  CustomHostname,
  type OwnershipVerification,
  type ValidationRecord,
} from "../CustomHostname/CustomHostname.ts";
import { CLOUDFLARE_DNS } from "../DNS/Adapter.ts";
import { findZoneByName, isId, type Reference as ZoneReference } from "../Zone/lookup.ts";
import type { WorkerDomainConfig, WorkerProps, WorkerRouteConfig } from "./Worker.ts";

/**
 * A Worker's `domain` cannot be served through Cloudflare for SaaS as
 * configured — the SaaS zone or `cnameTarget` is missing, or it uses an
 * option (`redirects`, `previews`) that only native custom domains
 * support. Raised as a defect while the stack program is being built,
 * before anything is deployed.
 */
export class WorkerDomainDnsError extends Data.TaggedError("WorkerDomainDnsError")<{
  readonly workerId: string;
  readonly message: string;
}> {}

type Props = WorkerProps<any, any>;

/**
 * The ownership-verification TXT record plus the certificate DCV TXT
 * records of a custom hostname, de-duplicated. Entries Cloudflare has not
 * populated (yet) are skipped.
 *
 * @internal exported for unit testing.
 */
export const customHostnameVerificationRecords = (
  ownership: OwnershipVerification | undefined,
  validation: ValidationRecord[] | undefined,
): DNS.DnsRecord[] => {
  const records: DNS.DnsRecord[] = [];
  const seen = new Set<string>();
  const push = (name: string | undefined, value: string | undefined) => {
    if (!name || !value) return;
    const key = `${DNS.normalizeDnsName(name)} ${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    records.push({ name, type: "TXT", value });
  };
  push(ownership?.name, ownership?.value);
  for (const record of validation ?? []) {
    push(record.txtName, record.txtValue);
  }
  return records;
};

const sanitize = (hostname: string) => hostname.replaceAll(/[^a-zA-Z0-9-]/g, "-");

/**
 * The Worker's `transformProps` hook. `domain.dns` omitted keeps the
 * native custom-domain path with the props untouched; a Cloudflare
 * adapter is stripped back to the native path; any other adapter composes
 * the Cloudflare for SaaS resources and replaces `domain` with routes on
 * the SaaS zone. A no-op at runtime and for Workers running locally under
 * `alchemy dev` (the local Worker ignores `domain`).
 */
export const transformWorkerDomainProps = (
  id: string,
  props: Props | undefined,
): Effect.Effect<Props | undefined, never, any> =>
  Effect.gen(function* () {
    // `Platform` hands a bare-tag forward reference (no props yet) to the
    // hook as `{}`. Keep it `undefined` so `Plan.make` still fails fast
    // when the tag's `.make` Layer is never provided (#1054).
    if (props === undefined || Object.keys(props).length === 0) {
      return undefined;
    }
    if (globalThis.__ALCHEMY_RUNTIME__) return props;
    const domain = props.domain;
    if (domain === undefined || domain === null || typeof domain !== "object") {
      return props;
    }
    const dns = domain.dns;
    if (dns === undefined) return props;
    if (dns.type === CLOUDFLARE_DNS) {
      const { dns: _dns, cnameTarget: _cnameTarget, ...native } = domain;
      // Native custom domains already publish their own DNS. The adapter's
      // zone pins the zone when the domain config does not.
      const pinned =
        native.zoneId !== undefined || native.zoneName !== undefined || native.zone !== undefined;
      return {
        ...props,
        domain:
          pinned || dns.zone === undefined
            ? native
            : { ...native, zone: dns.zone as unknown as ZoneReference },
      };
    }
    // The local Worker serves on localhost and ignores `domain`.
    if ((yield* defaultProviderMode) === "local") return props;
    return yield* composeSaasDomain(id, props, domain, dns).pipe(Namespace.push(id));
  });

const composeSaasDomain = (
  id: string,
  props: Props,
  domain: WorkerDomainConfig,
  dns: DNS.DnsConfig,
) =>
  Effect.gen(function* () {
    const fail = (message: string) =>
      Effect.die(
        new WorkerDomainDnsError({
          workerId: id,
          message: `Cloudflare.Worker "${id}": ${message}`,
        }),
      );
    const via = `\`domain.dns\` is "${dns.type}" (served through Cloudflare for SaaS)`;
    if ((domain.redirects?.length ?? 0) > 0) {
      return yield* fail(
        `\`domain.redirects\` is not supported when ${via} — redirect rules need the hostname in a Cloudflare zone. Serve the redirect hostnames from the Worker, or move their DNS to Cloudflare.`,
      );
    }
    if (domain.previews === true) {
      return yield* fail(
        `\`domain.previews\` is not supported when ${via} — Worker Previews need a native custom domain in a Cloudflare zone.`,
      );
    }
    const cnameTarget = domain.cnameTarget;
    if (cnameTarget === undefined) {
      return yield* fail(
        `\`domain.cnameTarget\` is required when ${via}: the hostname in the SaaS zone that custom hostnames CNAME to, typically the zone's fallback origin (\`Cloudflare.CustomHostname.FallbackOrigin\`).`,
      );
    }
    const hostnames = [...new Set([domain.name, ...(domain.aliases ?? [])])] as unknown[];
    for (const hostname of hostnames) {
      if (typeof hostname !== "string") {
        return yield* fail(
          `domain hostnames must be plain strings when ${via} — each one names its own resources.`,
        );
      }
    }
    const zoneId = yield* resolveSaasZoneId(domain, fail, via);
    const adapter = yield* DNS.resolve(dns);

    const routes: WorkerRouteConfig[] = [];
    for (const hostname of hostnames as string[]) {
      const key = sanitize(hostname);
      const customHostname = yield* CustomHostname(`CustomHostname-${key}`, {
        zoneId: zoneId as string,
        hostname,
        // TXT DCV yields `txtName`/`txtValue` validation records the DNS
        // host publishes alongside the ownership TXT.
        ssl: { method: "txt", type: "dv" },
      });
      yield* adapter.records(`Hostname-${key}-Verification`, {
        records: Output.map(
          Output.all(customHostname.ownershipVerification, customHostname.validationRecords),
          ([ownership, validation]) =>
            customHostnameVerificationRecords(
              ownership as OwnershipVerification | undefined,
              validation as ValidationRecord[] | undefined,
            ),
        ) as unknown as Input<DNS.DnsRecord[]>,
      });
      yield* adapter.alias(`Hostname-${key}`, {
        name: hostname,
        target: { hostname: cnameTarget },
      });
      // The route API only accepts a pattern outside the zone's own names
      // for a custom hostname of a Cloudflare for SaaS zone (otherwise
      // `InvalidRoutePattern`, code 10022), so derive the pattern from the
      // custom hostname: the Worker deploys after it.
      routes.push({
        pattern: Output.map(customHostname.hostname, (name) => `${name}/*`) as unknown as string,
        zoneId: zoneId as string,
      });
    }

    const { domain: _domain, ...rest } = props;
    return {
      ...rest,
      routes: [...(props.routes ?? []), ...routes],
    } satisfies Props;
  });

/**
 * The SaaS zone's id: `zoneId`, a `{ zoneId }` zone (e.g. a
 * `Cloudflare.Zone.Zone`), or a zone-id string are used as-is; a zone name
 * is looked up in the account.
 */
const resolveSaasZoneId = (
  domain: WorkerDomainConfig,
  fail: (message: string) => Effect.Effect<never>,
  via: string,
) =>
  Effect.gen(function* () {
    if (domain.zoneId !== undefined) return domain.zoneId as Input<string>;
    const zone = domain.zone as Input<ZoneReference> | undefined;
    if (Output.isOutput(zone)) {
      return Output.map(zone as Output.Output<ZoneReference>, (value) =>
        typeof value === "string" ? value : value.zoneId,
      ) as unknown as Input<string>;
    }
    if (typeof zone === "object") {
      return (zone as { zoneId: Input<string> }).zoneId;
    }
    if (typeof zone === "string" && isId(zone)) return zone;
    const name = typeof zone === "string" ? zone : domain.zoneName;
    if (name === undefined) {
      return yield* fail(
        `\`domain.zoneId\`, \`domain.zone\`, or \`domain.zoneName\` is required when ${via}: the Cloudflare zone (with Cloudflare for SaaS enabled) that hosts the custom hostnames and the Worker routes.`,
      );
    }
    if (typeof name !== "string") {
      return yield* fail(
        `a zone name given as an Output cannot be looked up while the stack is built — pass the zone id (\`domain.zoneId\`) or the \`Cloudflare.Zone.Zone\` resource (\`domain.zone\`).`,
      );
    }
    const { accountId } = yield* yield* CloudflareEnvironment;
    const match = yield* findZoneByName({ accountId, name }).pipe(
      Effect.catch((error) => fail(`looking up the SaaS zone "${name}" failed: ${String(error)}`)),
    );
    if (match === undefined) {
      return yield* fail(`the SaaS zone "${name}" was not found in the Cloudflare account.`);
    }
    return match.id as Input<string>;
  });
