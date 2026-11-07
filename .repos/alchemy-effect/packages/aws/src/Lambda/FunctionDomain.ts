import type { DnsConfig } from "alchemy/DNS/Adapter";
import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import { defaultProviderMode, type ProviderMode } from "alchemy/ProviderMode";
/**
 * Custom domains for `AWS.Lambda.Function`.
 *
 * Lambda Function URLs cannot serve a custom hostname, so a Function's
 * `domain` composes an API Gateway v2 HTTP API front door (the
 * `ApiGatewayV2.HttpApi` composite: `$default` route, `AWS_PROXY`
 * integration with payload 2.0 — the Function URL event shape — and an
 * auto-deployed `$default` stage), a regional ACM certificate, one
 * `ApiGatewayV2.DomainName` + `ApiMapping` per hostname, and the alias
 * records, published through whichever DNS host `domain.dns` names.
 *
 * Composition references the Function's own outputs (ARN, name), so it
 * runs from the platform's `onCreate` hook, after the Function resource is
 * declared.
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { ApiMapping } from "../ApiGatewayV2/ApiMapping.ts";
import { DomainName } from "../ApiGatewayV2/DomainName.ts";
import { HttpApi } from "../ApiGatewayV2/HttpApi.ts";
import { domainCertificate, resolveDomainDns } from "../CustomDomain.ts";
import { qualifiedArnOf, qualifiedNameOf } from "./QualifiedArn.ts";

/** Object form of the `AWS.Lambda.Function` `domain` prop. */
export interface FunctionDomainConfig {
  /**
   * Hostname that serves the Function, e.g. `api.example.com`. The
   * Function's `domainUrl` attribute is `https://{name}`.
   */
  name: string;
  /**
   * Additional hostnames that serve the Function. Each gets its own API
   * Gateway domain name, API mapping, alias record, and a subject
   * alternative name on the ACM certificate.
   */
  aliases?: string[];
  /**
   * Route 53 hosted zone for the certificate validation and alias records.
   * Optional — when omitted, the most specific PUBLIC hosted zone in the
   * account containing each hostname is inferred. Ignored when {@link dns}
   * names another DNS host.
   */
  hostedZoneId?: string;
  /**
   * DNS host for the certificate validation and alias records (see
   * [DNS Adapters](/infrastructure-as-code/dns-adapters)). Omitted: Route
   * 53 (see {@link hostedZoneId}) with an `A` alias record per hostname.
   * Pass `Cloudflare.DNS.Adapter()` or `Hetzner.DNS.Adapter()` for a
   * domain whose DNS lives there — each hostname gets a `CNAME` to the API
   * Gateway domain and the certificate is validated through that host.
   */
  dns?: DnsConfig;
}

/**
 * A Function's custom domain: a hostname (Route 53 DNS), or a
 * {@link FunctionDomainConfig}.
 */
export type FunctionDomain = string | FunctionDomainConfig;

/**
 * The `domain` prop of an `AWS.Lambda.Function` is invalid (empty or
 * duplicate hostnames). Raised as a defect while the stack program is
 * built, before anything is deployed.
 */
export class InvalidFunctionDomain extends Data.TaggedError("InvalidFunctionDomain")<{
  readonly functionId: string;
  readonly message: string;
}> {}

/** Normalize the `domain` prop to its object form. */
export const normalizeFunctionDomain = (
  domain: FunctionDomain | undefined,
): FunctionDomainConfig | undefined =>
  domain === undefined ? undefined : typeof domain === "string" ? { name: domain } : domain;

/** `https://{name}` of a Function's custom domain. */
export const functionDomainUrl = (domain: FunctionDomain | undefined): string | undefined => {
  const config = normalizeFunctionDomain(domain);
  return config === undefined ? undefined : `https://${config.name}`;
};

/** The Function outputs the front door references. */
interface FunctionDomainHost {
  readonly LogicalId: string;
  readonly Mode: ProviderMode | undefined;
  readonly functionArn: Output.Output<string>;
  readonly functionName: Output.Output<string>;
  readonly qualifiedArn: Output.Output<string>;
}

/**
 * Compose the API Gateway front door and DNS for a Function's `domain`
 * under the Function's namespace. A no-op at runtime, without a `domain`,
 * and when the Function runs locally under `alchemy dev` (a local Function
 * has no cloud ARN to integrate; opt a Function out with `Alchemy.remote()`
 * to serve its domain during dev).
 *
 * Resources (under `{FunctionId}/`):
 *
 * - `Api/*` — `ApiGatewayV2.HttpApi` (Api, Integration, `$default` Route,
 *   Stage, invoke Permission)
 * - `Certificate` (+ `CertificateValidation` / `CertificateIssued` on a
 *   non-Route 53 DNS host) — in the Function's region
 * - `DomainName-{host}` / `ApiMapping-{host}` — per hostname
 * - `Domain-{host}` — the DNS host's alias record(s) per hostname
 */
export const composeFunctionDomain = (
  fn: FunctionDomainHost,
  domainProp: FunctionDomain | undefined,
): Effect.Effect<void, never, any> =>
  Effect.gen(function* () {
    if (globalThis.__ALCHEMY_RUNTIME__) return;
    const domain = normalizeFunctionDomain(domainProp);
    if (domain === undefined) return;
    if ((fn.Mode ?? (yield* defaultProviderMode)) === "local") return;

    const id = fn.LogicalId;
    const names = [domain.name, ...(domain.aliases ?? [])];
    if (names.some((name) => typeof name !== "string" || name.length === 0)) {
      return yield* Effect.die(
        new InvalidFunctionDomain({
          functionId: id,
          message: `AWS.Lambda.Function "${id}": \`domain\` names must be non-empty hostnames`,
        }),
      );
    }
    const ids = names.map((name) => name.replaceAll(/[^a-zA-Z0-9-]/g, "-"));
    if (new Set(ids).size !== ids.length) {
      return yield* Effect.die(
        new InvalidFunctionDomain({
          functionId: id,
          message: `AWS.Lambda.Function "${id}": \`domain\` lists the same hostname more than once (${names.join(", ")})`,
        }),
      );
    }

    yield* Effect.gen(function* () {
      // Integrate and grant invoke on the alias when the Function has one.
      const { api, stage } = yield* HttpApi("Api", {
        handler: {
          LogicalId: id,
          functionArn: qualifiedArnOf(fn),
          functionName: qualifiedNameOf(fn),
        },
      });

      // API Gateway regional domains need a certificate in the API's
      // region, which is the Function's.
      const region = Output.map(fn.functionArn, (arn: string) => arn.split(":")[3]!);
      const { certificateArn } = yield* domainCertificate(
        "Certificate",
        {
          domainName: domain.name,
          ...(domain.aliases?.length ? { subjectAlternativeNames: domain.aliases } : {}),
          ...(domain.hostedZoneId === undefined ? {} : { hostedZoneId: domain.hostedZoneId }),
          region: region as unknown as string,
        },
        domain.dns,
      );

      const dns = yield* resolveDomainDns(domain.dns, domain.hostedZoneId);
      for (const [index, name] of names.entries()) {
        const host = ids[index]!;
        const apiDomain = yield* DomainName(`DomainName-${host}`, {
          domainName: name,
          domainNameConfigurations: [
            {
              CertificateArn: certificateArn as unknown as string,
              EndpointType: "REGIONAL",
              SecurityPolicy: "TLS_1_2",
            },
          ],
        });
        yield* ApiMapping(`ApiMapping-${host}`, {
          api,
          domainName: apiDomain.domainName,
          stage: stage.stageName,
        });
        // The API Gateway-managed target (`d-xxxx.execute-api.{region}.
        // amazonaws.com`) and its Route 53 alias zone.
        yield* dns.alias(`Domain-${host}`, {
          name,
          target: {
            hostname: Output.map(
              apiDomain.domainNameConfigurations,
              (configs) => configs?.[0]?.ApiGatewayDomainName!,
            ),
            route53Alias: {
              hostedZoneId: Output.map(
                apiDomain.domainNameConfigurations,
                (configs) => configs?.[0]?.HostedZoneId!,
              ),
            },
          },
        });
      }
    }).pipe(Namespace.push(id));
  }) as Effect.Effect<void, never, any>;
