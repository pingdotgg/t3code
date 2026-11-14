import * as DNS from "alchemy/DNS/Adapter";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
/**
 * Custom-domain plumbing shared by AWS composites (the `AWS.Website.*`
 * sites and Router, `AWS.ECS.Service`, `AWS.Lambda.Function`): the ACM
 * certificate and the records pointing hostnames at the AWS target, through
 * whichever DNS host `domain.dns` names.
 *
 * Route 53 — the default — keeps the exact resources AWS composites
 * declared before DNS adapters existed (an inline-validated
 * `AWS.ACM.Certificate` plus `AWS.Route53.Record`s), so existing stacks plan
 * no changes. Any other DNS host validates the certificate externally:
 * `Certificate` (`dnsValidation: "external"`) → the adapter's validation
 * records → `AWS.ACM.CertificateValidation`.
 *
 * Not exported from the AWS barrel.
 */
import * as Effect from "effect/Effect";
import { Certificate, validationRecordsOf, type CertificateProps } from "./ACM/Certificate.ts";
import { CertificateValidation } from "./ACM/CertificateValidation.ts";
import type { Providers } from "./Providers.ts";
import { adapter as route53Adapter, ROUTE53_DNS } from "./Route53/Adapter.ts";

/** Whether `dns` is Route 53 (explicit, or the default when omitted). */
export const isRoute53Dns = (dns: DNS.DnsConfig | undefined) =>
  dns === undefined || dns.type === ROUTE53_DNS;

/**
 * The DNS adapter of an AWS custom domain: the explicit `dns` adapter, or
 * Route 53 (pinned to `hostedZoneId` when given) when omitted. Route 53 is
 * built directly — AWS composites need no registry lookup for their own
 * DNS host.
 */
export const resolveDomainDns = (
  dns: DNS.DnsConfig | undefined,
  hostedZoneId?: Input<string>,
): Effect.Effect<DNS.DnsAdapter<Providers>> =>
  isRoute53Dns(dns)
    ? Effect.succeed(
        DNS.bind(
          route53Adapter,
          dns ?? {
            type: ROUTE53_DNS,
            ...(hostedZoneId === undefined ? {} : { zone: hostedZoneId }),
          },
        ),
      )
    : DNS.resolve(dns!);

/**
 * An ACM certificate for a custom domain, validated through `dns`.
 *
 * - Route 53 (omitted, explicit, or `false` — "no alias records" still
 *   validates in Route 53): `Certificate(id, props)` exactly as given; the
 *   provider publishes the validation records inline and waits.
 * - Any other host: `Certificate(id, { ...props, dnsValidation:
 *   "external" })`, the adapter's `{id}Validation` records (retained on
 *   destroy — ACM reuses one CNAME per name across certificates), and
 *   `{id}Issued` (`AWS.ACM.CertificateValidation`).
 *
 * `certificateArn` resolves only once the certificate is issued, so a
 * distribution, listener, or API Gateway domain that takes it deploys after
 * issuance.
 */
export const domainCertificate = Effect.fn("AWS.domainCertificate")(function* (
  id: string,
  props: CertificateProps,
  dns: DNS.DnsConfig | false | undefined,
) {
  if (dns === false || isRoute53Dns(dns)) {
    const certificate = yield* Certificate(id, props);
    return { certificate, certificateArn: certificate.certificateArn };
  }
  const adapter = yield* DNS.resolve(dns!);
  const { hostedZoneId: _ignored, ...rest } = props;
  const certificate = yield* Certificate(id, {
    ...rest,
    dnsValidation: "external",
  });
  yield* adapter.records(`${id}Validation`, {
    records: Output.map(
      certificate.domainValidationOptions,
      validationRecordsOf,
    ) as unknown as Input<DNS.DnsRecord[]>,
    retain: true,
  });
  const issued = yield* CertificateValidation(`${id}Issued`, {
    certificateArn: certificate.certificateArn,
  });
  return { certificate, certificateArn: issued.certificateArn };
});
