import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as ProviderLayer from "alchemy/Local/ProviderLayer";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import type { App } from "./App.ts";
import {
  PrismaApiError,
  PrismaClient,
  isConflict,
  isNotFound,
  type PrismaManagementClient,
} from "./Client.ts";
import type { Compute } from "./Compute.ts";
import { DEV_TIMESTAMP, attrOrString, devId, devProvider } from "./internal/DevStub.ts";
import { concreteIdOf, concreteIdsChanged, isInputObject, isPrismaDevId } from "./internal/Refs.ts";
import type { Providers } from "./Providers.ts";
import type { CustomDomain as ApiCustomDomain } from "./Types.ts";

export class CustomDomainConflict extends Data.TaggedError("CustomDomainConflict")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class CustomDomainInvalidProps extends Data.TaggedError("CustomDomainInvalidProps")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class CustomDomainOperationFailed extends Data.TaggedError("CustomDomainOperationFailed")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class CustomDomainUnexpectedResponse extends Data.TaggedError(
  "CustomDomainUnexpectedResponse",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

type AppReference = string | App | Compute;

export interface CustomDomainProps {
  /**
   * App ID or Compute output that owns the domain.
   */
  app: AppReference;
  /**
   * Hostname to attach to the app.
   */
  hostname: string;
}

export interface CustomDomain extends Resource<
  "Prisma.CustomDomain",
  CustomDomainProps,
  {
    /**
     * Prisma custom domain ID.
     */
    customDomainId: string;
    /**
     * Hostname attached to the app.
     */
    hostname: string;
    /**
     * Current app ID that owns the domain.
     */
    appId: string;
    /**
     * Prisma normalized custom domain provisioning status.
     */
    status: ApiCustomDomain["status"];
    /**
     * Raw custom-domain status returned by Foundry.
     */
    foundryStatus: string;
    /**
     * Failure reason returned by Prisma, when provisioning failed.
     */
    failureReason: string | null;
    /**
     * Failure category returned by Prisma, when provisioning failed.
     */
    failureCategory: ApiCustomDomain["failureCategory"];
    /**
     * Certificate expiration timestamp, when available.
     */
    certExpiresAt: string | null;
    /**
     * DNS records the hostname should point at.
     */
    dnsRecords: ApiCustomDomain["dnsRecords"];
    /**
     * ISO timestamp when the custom domain was created.
     */
    createdAt: string;
    /**
     * ISO timestamp when the custom domain was last updated.
     */
    updatedAt: string;
  },
  never,
  Providers
> {}

/**
 * A Prisma app custom domain.
 *
 * Prisma verifies the hostname's `CNAME` to the app's regional switchboard
 * (`switchboard.{region}.prisma.build`, listed in `dnsRecords`) when the
 * domain is created, so publish it first. Creation then starts asynchronous
 * certificate provisioning; inspect `status`, `foundryStatus`, and
 * `failureReason` before routing production traffic.
 *
 * App and hostname changes are intentionally rejected because the Management
 * API cannot replace a live domain atomically. Create a second resource,
 * verify DNS and TLS, cut traffic over, and then remove the old resource.
 *
 * ### Creating a Custom Domain
 * **Example:** Attach a hostname to an app
 * ```typescript
 * const domain = yield* Prisma.CustomDomain("api-domain", {
 *   app: api.appId,
 *   hostname: "api.example.com",
 * });
 * ```
 *
 * @resource
 * @product Compute
 */
export const CustomDomain = Resource<CustomDomain>("Prisma.CustomDomain");

const attrsFrom = (domain: ApiCustomDomain): CustomDomain["Attributes"] => ({
  customDomainId: domain.id,
  hostname: domain.hostname,
  appId: domain.appId,
  status: domain.status,
  foundryStatus: domain.foundryStatus,
  failureReason: domain.failureReason,
  failureCategory: domain.failureCategory,
  certExpiresAt: domain.certExpiresAt,
  dnsRecords: domain.dnsRecords,
  createdAt: domain.createdAt,
  updatedAt: domain.updatedAt,
});

const normalizeHostname = (hostname: string) => hostname.trim().replace(/\.$/, "").toLowerCase();

const sameHostname = (left: string, right: string) =>
  normalizeHostname(left) === normalizeHostname(right);

const adoptionRequiredError = (hostname: string, appId: string, detail: string) =>
  new Error(
    `Prisma custom domain '${hostname}' ${detail} on App '${appId}' but is not owned by this resource. Import it with explicit adoption instead of silently taking it over.`,
  );

const appIdValue = (app: AppReference | undefined) => (typeof app === "string" ? app : app?.appId);

const unresolvedAppIdOf = (app: AppReference | undefined) => concreteIdOf(appIdValue(app));

const resolveAppId = (app: AppReference) => {
  const value = appIdValue(app);
  return typeof value === "string"
    ? Effect.succeed(value)
    : Effect.fail(new CustomDomainOperationFailed({ message: "Unable to resolve Prisma app id." }));
};

const findDomain = (client: PrismaManagementClient, appId: string, hostname: string) =>
  client.listAppDomains(appId).pipe(
    Effect.catchIf(isNotFound, () => Effect.succeed([])),
    Effect.flatMap((domains) => {
      const matches = domains.filter((domain) => sameHostname(domain.hostname, hostname));
      return matches.length > 1
        ? Effect.fail(
            new CustomDomainConflict({
              message: `Prisma app '${appId}' has multiple custom domains matching '${hostname}'; refusing to select one arbitrarily.`,
            }),
          )
        : Effect.succeed(matches[0]);
    }),
  );

/**
 * Registration verifies the hostname's CNAME; a record published moments
 * earlier may not be visible to Prisma's resolver yet.
 */
const isDnsNotConfigured = (error: unknown): boolean =>
  error instanceof PrismaApiError &&
  error.status === 400 &&
  error.body !== undefined &&
  Redacted.value(error.body).includes("DNS is not configured");

interface NodeDns {
  readonly resolveNs: (name: string) => Promise<string[]>;
  readonly resolve4: (name: string) => Promise<string[]>;
  readonly Resolver: new () => {
    setServers(servers: string[]): void;
    resolveCname(name: string): Promise<string[]>;
    cancel(): void;
  };
}

/**
 * Prisma verifies the CNAME on registration through a caching resolver: a
 * lookup that races a just-published record caches NXDOMAIN for the zone's
 * SOA minimum (30 minutes on Cloudflare), failing every retry. Wait
 * (bounded) until every authoritative nameserver answers a CNAME, plus a
 * margin for anycast edges. Proceeds regardless, so an unpublished record
 * still surfaces Prisma's own error.
 */
const waitForAuthoritativeCname = (hostname: string) =>
  Effect.gen(function* () {
    const dns = yield* Effect.tryPromise((): Promise<NodeDns> => import("node:dns/promises")).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    if (dns === undefined || typeof dns.Resolver !== "function") return;
    const labels = hostname.split(".");
    let servers: string[] = [];
    for (let i = 1; i < labels.length - 1 && servers.length === 0; i++) {
      const names = yield* Effect.tryPromise(() => dns.resolveNs(labels.slice(i).join("."))).pipe(
        Effect.orElseSucceed(() => [] as string[]),
      );
      const addresses = yield* Effect.forEach(
        names,
        (name) =>
          Effect.tryPromise(() => dns.resolve4(name)).pipe(
            Effect.orElseSucceed(() => [] as string[]),
          ),
        { concurrency: "unbounded" },
      );
      servers = addresses.flat();
    }
    if (servers.length === 0) return;
    const answeredBy = (server: string) =>
      Effect.gen(function* () {
        const resolver = yield* Effect.sync(() => {
          const instance = new dns.Resolver();
          instance.setServers([server]);
          return instance;
        });
        // A timed-out query keeps retrying in c-ares unless cancelled.
        const answers = yield* Effect.tryPromise(() => resolver.resolveCname(hostname)).pipe(
          Effect.onInterrupt(() => Effect.sync(() => resolver.cancel())),
        );
        return answers.length > 0;
      }).pipe(
        Effect.timeout("3 seconds"),
        Effect.orElseSucceed(() => false),
      );
    const visible = yield* Effect.forEach(servers, answeredBy, {
      concurrency: "unbounded",
    }).pipe(
      Effect.map((seen) => seen.every(Boolean)),
      Effect.repeat({
        schedule: Schedule.spaced("3 seconds"),
        until: (seen) => seen,
        times: 20,
      }),
    );
    if (visible) yield* Effect.sleep("10 seconds");
  });

const ProviderLive = () =>
  Provider.effect(
    CustomDomain,
    Effect.gen(function* () {
      const client = yield* PrismaClient;
      return {
        stables: ["customDomainId"],
        list: Effect.fn(function* () {
          const apps = yield* client.listApps();
          const domains = yield* Effect.forEach(
            apps,
            (app) =>
              client
                .listAppDomains(app.id)
                .pipe(Effect.catchIf(isNotFound, () => Effect.succeed([]))),
            { concurrency: 8 },
          );
          return domains.flat().map(attrsFrom);
        }),
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!isInputObject(news)) return undefined;
          if (isPrismaDevId(output?.customDomainId)) {
            return { action: "update" } as const;
          }
          const oldAppId = output?.appId ?? unresolvedAppIdOf(olds.app);
          const newAppId = isResolved(news.app)
            ? unresolvedAppIdOf(news.app as AppReference)
            : undefined;
          const oldHostname = normalizeHostname(output?.hostname ?? olds.hostname);
          const newHostname = isResolved(news.hostname)
            ? normalizeHostname(news.hostname)
            : undefined;
          if (
            concreteIdsChanged(oldAppId, newAppId) ||
            (newHostname !== undefined && newHostname !== oldHostname)
          ) {
            return yield* new CustomDomainInvalidProps({
              message: `Prisma cannot atomically replace custom domain '${oldHostname}' without risking traffic before the new domain is active. Create a second Prisma.CustomDomain logical resource, verify DNS/TLS and cut traffic over explicitly, then remove this resource.`,
            });
          }
          // A live failed Foundry attempt reaches the canonical retry endpoint
          // below. Each reconcile performs at most one retry and never polls.
          if (output?.status === "failed") {
            return { action: "update" } as const;
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ output, olds }) {
          const customDomainId = isPrismaDevId(output?.customDomainId)
            ? undefined
            : output?.customDomainId;
          const findDomainInApp = Effect.gen(function* () {
            const appId = unresolvedAppIdOf(olds.app);
            return appId ? yield* findDomain(client, appId, olds.hostname) : undefined;
          });
          const domain = customDomainId
            ? yield* client
                .getCustomDomain(customDomainId)
                .pipe(Effect.catchIf(isNotFound, () => Effect.undefined))
            : yield* findDomainInApp;
          if (!domain) return undefined;
          const attrs = attrsFrom(domain);
          return customDomainId === undefined ? Unowned(attrs) : attrs;
        }),
        reconcile: Effect.fn(function* ({ news, output }) {
          const appId = yield* resolveAppId(news.app);
          const hostname = normalizeHostname(news.hostname);
          const customDomainId = isPrismaDevId(output?.customDomainId)
            ? undefined
            : output?.customDomainId;
          const domain = customDomainId
            ? yield* client
                .getCustomDomain(customDomainId)
                .pipe(Effect.catchIf(isNotFound, () => Effect.undefined))
            : yield* findDomain(client, appId, hostname);
          const identityMatches = (domain: ApiCustomDomain) =>
            domain.appId === appId && sameHostname(domain.hostname, hostname);
          if (domain && !identityMatches(domain)) {
            return yield* new CustomDomainConflict({
              message: `Prisma custom domain '${customDomainId}' resolves to app '${domain.appId}' and hostname '${domain.hostname}', not requested app '${appId}' and hostname '${hostname}'. Refusing to claim convergence; replace the mismatched domain.`,
            });
          }
          if (domain && customDomainId === undefined) {
            return yield* Effect.fail(adoptionRequiredError(hostname, appId, "already exists"));
          }
          if (!domain) {
            yield* waitForAuthoritativeCname(hostname);
          }
          const reconciled = domain
            ? domain.status === "failed"
              ? yield* client.retryCustomDomain(domain.id)
              : domain
            : yield* client.createAppDomain(appId, { hostname }).pipe(
                Effect.retry({
                  while: isDnsNotConfigured,
                  schedule: Schedule.spaced("5 seconds"),
                  times: 6,
                }),
                Effect.catchIf(isConflict, () =>
                  Effect.fail(
                    adoptionRequiredError(hostname, appId, "appeared after the adoption check"),
                  ),
                ),
                Effect.flatMap((result) =>
                  result.status === 201
                    ? Effect.succeed(result.domain)
                    : Effect.fail(
                        adoptionRequiredError(
                          hostname,
                          appId,
                          "was returned as already registered by the create request",
                        ),
                      ),
                ),
              );
          if (!identityMatches(reconciled)) {
            return yield* new CustomDomainUnexpectedResponse({
              message: `Prisma custom domain '${reconciled.id}' retry/create response resolves to app '${reconciled.appId}' and hostname '${reconciled.hostname}', not requested app '${appId}' and hostname '${hostname}'. Refusing to persist mismatched identity.`,
            });
          }
          return attrsFrom(reconciled);
        }),
        delete: Effect.fn(function* ({ output }) {
          const customDomainId = concreteIdOf(output.customDomainId);
          if (customDomainId === undefined) return;
          const domain = yield* client
            .getCustomDomain(customDomainId)
            .pipe(Effect.catchIf(isNotFound, () => Effect.undefined));
          if (!domain) return;
          if (domain.appId !== output.appId || !sameHostname(domain.hostname, output.hostname)) {
            return yield* new CustomDomainConflict({
              message: `Prisma custom domain '${customDomainId}' no longer matches app '${output.appId}' and hostname '${output.hostname}'. Refusing to delete a mismatched domain.`,
            });
          }
          yield* client
            .deleteCustomDomain(customDomainId)
            .pipe(Effect.catchIf(isNotFound, () => Effect.void));
        }),
      };
    }),
  );

const ProviderLocal = () =>
  devProvider(CustomDomain, ["customDomainId"], ({ id, news }) => ({
    customDomainId: devId("custom-domain", id),
    hostname: news.hostname,
    appId: attrOrString(news.app, "appId"),
    status: "active",
    foundryStatus: "active",
    failureReason: null,
    failureCategory: null,
    certExpiresAt: null,
    dnsRecords: [
      {
        type: "CNAME" as const,
        name: news.hostname,
        value: "localhost",
        ttl: null,
      },
    ],
    createdAt: DEV_TIMESTAMP,
    updatedAt: DEV_TIMESTAMP,
  }));

export const CustomDomainProvider = () =>
  ProviderLayer.dual(CustomDomain, {
    local: () => ProviderLocal(),
    live: () => ProviderLive(),
  });
