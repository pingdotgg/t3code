import * as Effect from "effect/Effect";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import * as Output from "../Output.ts";
import * as Provider from "../Provider.ts";
import {
  DEV_TIMESTAMP,
  attrOrString,
  devId,
  devProvider,
} from "./Internal/DevStub.ts";
import * as ProviderLayer from "../Local/ProviderLayer.ts";
import { Resource } from "../Resource.ts";
import {
  PrismaClient,
  isConflict,
  isNotFound,
  type PrismaManagementClient,
} from "./Client.ts";
import type { App } from "./App.ts";
import type { Compute } from "./Compute.ts";
import type { Providers } from "./Providers.ts";
import {
  concreteIdOf,
  concreteIdsChanged,
  isInputObject,
  isPrismaDevId,
} from "./Refs.ts";
import type { CustomDomain as ApiCustomDomain } from "./Types.ts";

type AppReference = string | App | Compute;

export interface CustomDomainProps {
  /**
   * App ID or Compute output that owns the domain. The App must be attached to
   * the project's current default branch.
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
 * Domains can only attach to Apps on the project's current default branch.
 * Creating this resource starts asynchronous DNS and certificate provisioning;
 * configure the returned `dnsRecords` and inspect `status`, `foundryStatus`,
 * and `failureReason` before routing production traffic.
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

const normalizeHostname = (hostname: string) =>
  hostname.trim().replace(/\.$/, "").toLowerCase();

const sameHostname = (left: string, right: string) =>
  normalizeHostname(left) === normalizeHostname(right);

const adoptionRequiredError = (
  hostname: string,
  appId: string,
  detail: string,
) =>
  new Error(
    `Prisma custom domain '${hostname}' ${detail} on App '${appId}' but is not owned by this resource. Import it with explicit adoption instead of silently taking it over.`,
  );

const appIdValue = (app: AppReference | undefined) =>
  typeof app === "string" ? app : app?.appId;

const unresolvedAppIdOf = (app: AppReference | undefined) =>
  concreteIdOf(appIdValue(app));

const resolveAppId = (app: AppReference) =>
  Effect.gen(function* () {
    const value = appIdValue(app);
    if (typeof value === "string") return value;
    if (Output.isOutput(value)) {
      const accessor = yield* value as Output.Output<string>;
      return yield* accessor;
    }
    return yield* Effect.fail(new Error("Unable to resolve Prisma app id."));
  });

const findDomain = (
  client: PrismaManagementClient,
  appId: string,
  hostname: string,
) =>
  client.listAppDomains(appId).pipe(
    Effect.catchIf(isNotFound, () => Effect.succeed([])),
    Effect.flatMap((domains) => {
      const matches = domains.filter((domain) =>
        sameHostname(domain.hostname, hostname),
      );
      return matches.length > 1
        ? Effect.fail(
            new Error(
              `Prisma app '${appId}' has multiple custom domains matching '${hostname}'; refusing to select one arbitrarily.`,
            ),
          )
        : Effect.succeed(matches[0]);
    }),
  );

const ensureDefaultBranchApp = (
  client: PrismaManagementClient,
  appId: string,
) =>
  Effect.gen(function* () {
    const app = yield* client.getApp(appId);
    if (!app.branchId) {
      return yield* Effect.fail(
        new Error(
          "Prisma custom domains can only be attached to apps on the default Branch.",
        ),
      );
    }
    const branch = yield* client
      .getBranch(app.branchId)
      .pipe(
        Effect.catchIf(isNotFound, () =>
          Effect.fail(
            new Error(
              `Unable to verify default Branch for Prisma app ${appId}.`,
            ),
          ),
        ),
      );
    if (!branch.isDefault) {
      return yield* Effect.fail(
        new Error(
          "Prisma custom domains can only be attached to apps on the default Branch.",
        ),
      );
    }
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
          const oldHostname = normalizeHostname(
            output?.hostname ?? olds.hostname,
          );
          const newHostname = isResolved(news.hostname)
            ? normalizeHostname(news.hostname)
            : undefined;
          if (
            concreteIdsChanged(oldAppId, newAppId) ||
            (newHostname !== undefined && newHostname !== oldHostname)
          ) {
            return yield* Effect.fail(
              new Error(
                `Prisma cannot atomically replace custom domain '${oldHostname}' without risking traffic before the new domain is active. Create a second Prisma.CustomDomain logical resource, verify DNS/TLS and cut traffic over explicitly, then remove this resource.`,
              ),
            );
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
          const domain = customDomainId
            ? yield* client
                .getCustomDomain(customDomainId)
                .pipe(
                  Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
                )
            : yield* Effect.gen(function* () {
                const appId = unresolvedAppIdOf(olds.app);
                return appId
                  ? yield* findDomain(client, appId, olds.hostname)
                  : undefined;
              });
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
                .pipe(
                  Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
                )
            : yield* findDomain(client, appId, hostname);
          const identityMatches = (domain: ApiCustomDomain) =>
            domain.appId === appId && sameHostname(domain.hostname, hostname);
          if (domain && !identityMatches(domain)) {
            return yield* Effect.fail(
              new Error(
                `Prisma custom domain '${customDomainId}' resolves to app '${domain.appId}' and hostname '${domain.hostname}', not requested app '${appId}' and hostname '${hostname}'. Refusing to claim convergence; replace the mismatched domain.`,
              ),
            );
          }
          if (domain && customDomainId === undefined) {
            return yield* Effect.fail(
              adoptionRequiredError(hostname, appId, "already exists"),
            );
          }
          if (!domain) {
            yield* ensureDefaultBranchApp(client, appId);
          }
          const reconciled = domain
            ? domain.status === "failed"
              ? yield* client.retryCustomDomain(domain.id)
              : domain
            : yield* client.createAppDomain(appId, { hostname }).pipe(
                Effect.catchIf(isConflict, () =>
                  Effect.fail(
                    adoptionRequiredError(
                      hostname,
                      appId,
                      "appeared after the adoption check",
                    ),
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
            return yield* Effect.fail(
              new Error(
                `Prisma custom domain '${reconciled.id}' retry/create response resolves to app '${reconciled.appId}' and hostname '${reconciled.hostname}', not requested app '${appId}' and hostname '${hostname}'. Refusing to persist mismatched identity.`,
              ),
            );
          }
          return attrsFrom(reconciled);
        }),
        delete: Effect.fn(function* ({ output }) {
          if (isPrismaDevId(output.customDomainId)) return;
          const domain = yield* client
            .getCustomDomain(output.customDomainId)
            .pipe(Effect.catchIf(isNotFound, () => Effect.succeed(undefined)));
          if (!domain) return;
          if (
            domain.appId !== output.appId ||
            !sameHostname(domain.hostname, output.hostname)
          ) {
            return yield* Effect.fail(
              new Error(
                `Prisma custom domain '${output.customDomainId}' no longer matches app '${output.appId}' and hostname '${output.hostname}'. Refusing to delete a mismatched domain.`,
              ),
            );
          }
          yield* client
            .deleteCustomDomain(output.customDomainId)
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
