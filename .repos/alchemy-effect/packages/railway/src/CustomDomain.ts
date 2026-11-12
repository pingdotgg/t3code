import { Query, type UnwrapPlan } from "@distilled.cloud/core/query";
import { Railway, type CustomDomain as RailwayCustomDomain } from "@distilled.cloud/railway";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { waitUntilDeleted, projectServices as fetchProjectServices } from "./GraphQL.ts";
import { matchesAlchemyPhysicalName } from "./Metadata.ts";
import { ownedProjects, projectEnvironmentIds } from "./Project.ts";
import type { Providers } from "./Providers.ts";
import { withEnvironmentConfigLock } from "./transient.ts";

const domainFields = <E>(domain: Query<RailwayCustomDomain, E>) => ({
  id: domain.id,
  domain: domain.domain,
  serviceId: domain.serviceId,
  environmentId: domain.environmentId,
  projectId: domain.projectId,
  targetPort: domain.targetPort,
  deletedAt: domain.deletedAt,
  syncStatus: domain.syncStatus,
  status: {
    verified: domain.status.verified,
    certificateStatus: domain.status.certificateStatus,
    certificateErrorMessage: domain.status.certificateErrorMessage,
    verificationDnsHost: domain.status.verificationDnsHost,
    verificationToken: domain.status.verificationToken,
    dnsRecords: domain.status.dnsRecords.pipe(
      Query.map((record) => ({
        fqdn: record.fqdn,
        zone: record.zone,
        recordType: record.recordType,
        requiredValue: record.requiredValue,
      })),
    ),
  },
});
type CloudDomain = UnwrapPlan<ReturnType<typeof domainFields>>;

const readCustomDomain = Query.fn((id: string, projectId: string) =>
  domainFields(Railway.customDomain({ id, projectId })),
);

const readCustomDomains = Query.fn((projectId: string, environmentId: string, serviceId: string) =>
  Railway.domains({ environmentId, projectId, serviceId }).customDomains.pipe(
    Query.map(domainFields),
  ),
);

const customDomainCreate = Query.fn(
  (input: {
    domain: string;
    environmentId: string;
    projectId: string;
    serviceId: string;
    targetPort?: number;
  }) => domainFields(Railway.customDomainCreate({ input })),
);

const customDomainUpdate = Query.fn(
  (input: { environmentId: string; id: string; targetPort: number }) =>
    Railway.customDomainUpdate(input),
);

const customDomainDelete = Query.fn((id: string) => Railway.customDomainDelete({ id }));

/**
 * A DNS record Railway requires for a custom domain.
 */
export interface CustomDomainDnsRecord {
  /** Fully qualified record name, e.g. `www.example.com`. */
  name: string;
  /** Record type. */
  type: "A" | "CNAME" | "TXT";
  /** Value Railway expects, e.g. the `*.up.railway.app` CNAME target. */
  value: string;
}

/**
 * A resource-valued prop: the resource itself, or an Effect that produces
 * it (so `yield* Service(...)` and `Service(...)` both type-check).
 */
type Ref<T> = T | Effect.Effect<T, never, Providers>;

/**
 * Parent Service identity. A `Railway.Service` resource satisfies this
 * via `serviceId`. Tests may pass a `{ serviceId }` stub created out of
 * band. `projectId` is optional when the environment carries it (a
 * `Railway.Project`).
 */
export type CustomDomainService = { readonly serviceId: string; readonly projectId?: string };

/**
 * Environment identity a custom domain is created in. Accepts a
 * `Railway.Project` (its primary environment), a `Railway.Environment`,
 * or an `{ environmentId }` stub.
 */
export type CustomDomainEnvironment = {
  readonly environmentId: string;
  readonly projectId?: string;
};

export interface CustomDomainProps {
  /**
   * Parent Railway Service. Accepts a `Railway.Service` resource or a
   * `{ serviceId }` stub. Changing the Service replaces the CustomDomain.
   */
  service: Ref<CustomDomainService>;
  /**
   * Environment to attach the hostname in. Accepts a `Railway.Project`
   * (primary environment), a `Railway.Environment`, or `{ environmentId }`.
   * Changing it replaces the CustomDomain.
   */
  environment: Ref<CustomDomainEnvironment>;
  /**
   * User hostname (`www.example.com`). Identity of the resource.
   * Changing it replaces the CustomDomain.
   */
  domain: string;
  /**
   * Service port Railway's edge should target. Updates in place via
   * `customDomainUpdate`. Omit to let Railway pick the service's public
   * port.
   */
  targetPort?: number;
}

export type CustomDomain = Resource<
  "Railway.CustomDomain",
  CustomDomainProps,
  {
    /** Railway custom domain id. */
    customDomainId: string;
    /** User hostname. */
    domain: string;
    /** Parent Railway service id. */
    serviceId: string;
    /** Parent Railway project id. */
    projectId: string;
    /** Environment the hostname is attached in. */
    environmentId: string;
    /** Observed target port, if set. */
    targetPort: number | undefined;
    /** Whether DNS ownership has been verified. */
    verified: boolean | undefined;
    /** ACME certificate issuance status, if the API returned one. */
    certificateStatus: string | undefined;
    /** Human-readable ACME error, if issuance failed. */
    certificateErrorMessage: string | undefined;
    /** DNS host Railway expects for the verification TXT record. */
    verificationDnsHost: string | undefined;
    /** DNS token Railway expects for the verification TXT record. */
    verificationToken: string | undefined;
    /**
     * Every record Railway requires for the hostname, with fully qualified
     * names: the routing `CNAME` (or `A`), any ACME challenge `CNAME`, and
     * the ownership verification `TXT`. Publish them with a DNS adapter
     * (see [DNS Adapters](/infrastructure-as-code/dns-adapters)).
     */
    dnsRecords: CustomDomainDnsRecord[];
    /** Observed sync status (`ACTIVE`, `CREATING`, …). */
    syncStatus: string | undefined;
    /** `https://{domain}`. */
    url: string;
  },
  never,
  Providers
>;

/**
 * A Railway.CustomDomain is a user hostname on a {@link CustomDomainService}.
 * Railway issues a Let's Encrypt certificate once DNS is verified.
 *
 * @see https://docs.railway.com/guides/public-networking
 *
 * ### Attach a hostname
 * Pass the parent Service, the environment id, and the hostname. Yield the
 * CustomDomain next to the Service. Publish the records listed in
 * `dnsRecords` (the routing `CNAME` and the `verificationDnsHost` /
 * `verificationToken` TXT) at your DNS host.
 *
 * **Example:** Basic CustomDomain
 * ```typescript
 * const site = yield* Railway.Project("Site");
 * const api = yield* Railway.Service("Api", {
 *   project: site,
 *   image: "hashicorp/http-echo",
 * });
 * const www = yield* Railway.CustomDomain("Www", {
 *   service: api,
 *   environment: site,
 *   domain: "www.example.com",
 * });
 * ```
 *
 * :::caution[Changing `domain`, `service`, or `environment` replaces the CustomDomain]
 * The old hostname is deleted. The new hostname is created.
 * :::
 *
 * ### Target port
 * `targetPort` is optional and updates in place. Railway's edge forwards
 * HTTPS on 443 to this port on the Service.
 *
 * **Example:** Explicit target port
 * ```typescript
 * const www = yield* Railway.CustomDomain("Www", {
 *   service: api,
 *   environment: site,
 *   domain: "www.example.com",
 *   targetPort: 8080,
 * });
 * ```
 *
 * ### Module-scope declarations
 * Declare the CustomDomain once. Resource-valued props accept the resource
 * or an Effect producing it.
 *
 * **Example:** Module-scope CustomDomain
 * ```typescript
 * // src/domain.ts
 * import * as Railway from "@alchemy.run/railway";
 * import { Api } from "./api.ts";
 * import { Site } from "./project.ts";
 *
 * export const Www = Railway.CustomDomain("Www", {
 *   service: Api,
 *   environment: Site,
 *   domain: "www.example.com",
 * });
 * ```
 *
 * @resource
 * @product Networking
 */
export const CustomDomain = Resource<CustomDomain>("Railway.CustomDomain");

export class CustomDomainNotCreated extends Data.TaggedError("Railway.CustomDomainNotCreated")<{
  domain: string;
  serviceId: string;
}> {}

export class CustomDomainServiceMissing extends Data.TaggedError(
  "Railway.CustomDomainServiceMissing",
)<{ domain: string }> {}

const serviceIdOf = (value: unknown): string | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as { serviceId?: unknown };
  if (typeof rec.serviceId === "string" && rec.serviceId.length > 0) {
    return rec.serviceId;
  }
  return undefined;
};

const projectIdOf = (value: unknown): string | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as { projectId?: unknown };
  if (typeof rec.projectId === "string" && rec.projectId.length > 0) {
    return rec.projectId;
  }
  return undefined;
};

const environmentIdOf = (value: unknown): string | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as { environmentId?: unknown };
  if (typeof rec.environmentId === "string" && rec.environmentId.length > 0) {
    return rec.environmentId;
  }
  return undefined;
};

const isGone = (domain: CloudDomain | undefined) =>
  domain === undefined || domain.deletedAt != null || domain.syncStatus === "DELETED";

const RECORD_TYPES = {
  DNS_RECORD_TYPE_A: "A",
  DNS_RECORD_TYPE_CNAME: "CNAME",
  DNS_RECORD_TYPE_TXT: "TXT",
} as const satisfies Record<string, CustomDomainDnsRecord["type"]>;

const trimDot = (name: string) => name.replace(/\.$/, "");

/** Qualify a (possibly zone-relative) host label with its zone. */
const qualify = (host: string, zone: string | undefined) => {
  const name = trimDot(host);
  if (zone === undefined || zone.length === 0) return name;
  const apex = trimDot(zone);
  if (name === "@" || name === "") return apex;
  const lower = name.toLowerCase();
  const lowerApex = apex.toLowerCase();
  return lower === lowerApex || lower.endsWith(`.${lowerApex}`) ? name : `${name}.${apex}`;
};

const toDnsRecords = (
  status:
    | {
        verificationDnsHost?: string | null;
        verificationToken?: string | null;
        dnsRecords?: ReadonlyArray<{
          fqdn: string;
          zone: string;
          recordType: string;
          requiredValue: string;
        }>;
      }
    | undefined,
): CustomDomainDnsRecord[] => {
  const observed = status?.dnsRecords ?? [];
  const records: CustomDomainDnsRecord[] = [];
  for (const record of observed) {
    // NS / unspecified records are not publishable by a DNS adapter.
    const type = (RECORD_TYPES as Record<string, CustomDomainDnsRecord["type"] | undefined>)[
      record.recordType
    ];
    if (type === undefined || record.requiredValue.length === 0) continue;
    records.push({
      name: qualify(record.fqdn, record.zone),
      type,
      value: record.requiredValue,
    });
  }
  const host = status?.verificationDnsHost ?? undefined;
  const token = status?.verificationToken ?? undefined;
  if (host !== undefined && host.length > 0 && token !== undefined) {
    const name = qualify(host, observed[0]?.zone);
    const listed = records.some(
      (record) => record.type === "TXT" && record.name.toLowerCase() === name.toLowerCase(),
    );
    if (!listed) records.push({ name, type: "TXT", value: token });
  }
  return records;
};

const toAttrs = (
  domain: CloudDomain,
  fallback?: { projectId?: string; environmentId?: string },
): CustomDomain["Attributes"] => {
  const status = domain.status;
  const name = domain.domain;
  return {
    customDomainId: domain.id,
    domain: name,
    serviceId: domain.serviceId,
    projectId: domain.projectId ?? fallback?.projectId ?? "",
    environmentId: domain.environmentId || fallback?.environmentId || "",
    targetPort: domain.targetPort ?? undefined,
    verified: status.verified,
    certificateStatus: status.certificateStatus,
    certificateErrorMessage: status.certificateErrorMessage ?? undefined,
    verificationDnsHost: status.verificationDnsHost ?? undefined,
    verificationToken: status.verificationToken ?? undefined,
    dnsRecords: toDnsRecords(status),
    syncStatus: domain.syncStatus,
    url: `https://${name}`,
  };
};

const getById = (customDomainId: string, projectId: string) =>
  readCustomDomain(customDomainId, projectId).pipe(
    Effect.map((domain) => (isGone(domain) ? undefined : domain)),
    Effect.catchTag("RailwayNotFound", () => Effect.undefined),
  );

const listServiceDomains = (projectId: string, environmentId: string, serviceId: string) =>
  readCustomDomains(projectId, environmentId, serviceId).pipe(
    Effect.map((customDomains) => customDomains.filter((domain) => !isGone(domain))),
    Effect.catchTag("RailwayNotFound", () => Effect.succeed([] as ReadonlyArray<CloudDomain>)),
  );

const findByDomain = (
  projectId: string,
  environmentId: string,
  serviceId: string,
  domain: string,
) =>
  listServiceDomains(projectId, environmentId, serviceId).pipe(
    Effect.map((domains) =>
      domains.find((item) => item.domain.toLowerCase() === domain.toLowerCase()),
    ),
  );

const observe = Effect.fn(function* (input: {
  customDomainId?: string;
  projectId: string;
  environmentId: string;
  serviceId: string;
  domain: string;
}) {
  if (
    input.customDomainId !== undefined &&
    input.customDomainId.length > 0 &&
    input.projectId.length > 0
  ) {
    const byId = yield* getById(input.customDomainId, input.projectId);
    if (byId !== undefined) return byId;
  }
  const listed = yield* findByDomain(
    input.projectId,
    input.environmentId,
    input.serviceId,
    input.domain,
  );
  if (listed === undefined) return undefined;
  if (listed.projectId !== null && listed.projectId.length > 0) {
    const full = yield* getById(listed.id, listed.projectId);
    if (full !== undefined) return full;
  }
  return listed;
});

const waitUntilGone = (customDomainId: string, projectId: string) =>
  waitUntilDeleted(
    "CustomDomain",
    customDomainId,
    getById(customDomainId, projectId).pipe(Effect.map((domain) => domain === undefined)),
  );

export const CustomDomainProvider = () =>
  Provider.succeed(CustomDomain, {
    stables: ["customDomainId", "serviceId", "projectId", "environmentId", "domain"],
    nuke: { dependsOn: ["Railway.Project"] },

    list: Effect.fn(function* () {
      const projects = yield* ownedProjects();
      const rows = yield* Effect.forEach(projects, (project) =>
        Effect.gen(function* () {
          const live = yield* fetchProjectServices(project.projectId, (service) => ({
            id: service.id,
            name: service.name,
            deletedAt: service.deletedAt,
          })).pipe(Effect.catchTag("RailwayNotFound", () => Effect.undefined));
          const services = (live ?? []).filter(
            (service) => service.deletedAt == null && matchesAlchemyPhysicalName(service.name),
          );
          const envIds = yield* projectEnvironmentIds(project);
          const nested = yield* Effect.forEach(services, (service) =>
            Effect.forEach(envIds, (environmentId) =>
              listServiceDomains(project.projectId, environmentId, service.id).pipe(
                Effect.map((domains) =>
                  domains.map((domain) =>
                    toAttrs(domain, { projectId: project.projectId, environmentId }),
                  ),
                ),
              ),
            ).pipe(Effect.map((rows) => rows.flat())),
          );
          return nested.flat();
        }),
      );
      return rows.flat();
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (news === undefined || !isResolved(news)) return undefined;
      if (output === undefined) return undefined;
      const serviceId = serviceIdOf(news.service);
      const serviceChanged = serviceId !== undefined && serviceId !== output.serviceId;
      const environmentId = environmentIdOf(news.environment);
      const environmentChanged =
        environmentId !== undefined && environmentId !== output.environmentId;
      const domainChanged = news.domain.toLowerCase() !== output.domain.toLowerCase();
      if (serviceChanged || environmentChanged || domainChanged) {
        return { action: "replace" as const, deleteFirst: !domainChanged };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const serviceId = output?.serviceId ?? serviceIdOf(olds?.service) ?? "";
      const projectId =
        output?.projectId ?? projectIdOf(olds?.service) ?? projectIdOf(olds?.environment) ?? "";
      const environmentId = output?.environmentId ?? environmentIdOf(olds?.environment) ?? "";
      const domain = output?.domain ?? olds?.domain;
      if (
        serviceId.length === 0 ||
        projectId.length === 0 ||
        environmentId.length === 0 ||
        domain === undefined ||
        domain.length === 0
      ) {
        return undefined;
      }
      const found = yield* observe({
        customDomainId: output?.customDomainId,
        projectId,
        environmentId,
        serviceId,
        domain,
      });
      if (found === undefined) return undefined;
      return toAttrs(found, { projectId, environmentId });
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const props = news ?? ({} as CustomDomainProps);
      const serviceId = serviceIdOf(props.service) ?? output?.serviceId ?? "";
      const projectId =
        projectIdOf(props.service) ?? projectIdOf(props.environment) ?? output?.projectId ?? "";
      const environmentId = environmentIdOf(props.environment) ?? output?.environmentId ?? "";
      const domain = props.domain ?? output?.domain ?? "";
      if (serviceId.length === 0 || projectId.length === 0) {
        return yield* new CustomDomainServiceMissing({ domain });
      }
      if (domain.length === 0 || environmentId.length === 0) {
        return yield* new CustomDomainNotCreated({ domain, serviceId });
      }

      let current = yield* observe({
        customDomainId: output?.customDomainId,
        projectId,
        environmentId,
        serviceId,
        domain: output?.domain ?? domain,
      });
      if (
        current === undefined &&
        (output?.domain !== domain ||
          output?.serviceId !== serviceId ||
          output?.environmentId !== environmentId)
      ) {
        current = yield* observe({ projectId, environmentId, serviceId, domain });
      }

      if (current === undefined) {
        const ensureDomain = Effect.gen(function* () {
          // A previous attempt may have created the hostname before its response failed.
          const observed = yield* observe({ projectId, environmentId, serviceId, domain });
          if (observed !== undefined) return observed;
          return yield* customDomainCreate({
            domain,
            environmentId,
            projectId,
            serviceId,
            ...(props.targetPort !== undefined ? { targetPort: props.targetPort } : {}),
          }).pipe(
            Effect.catchTag(
              ["RailwayCustomDomainCreateFailed", "RailwayValidationError"],
              (failure) =>
                observe({ projectId, environmentId, serviceId, domain }).pipe(
                  Effect.flatMap((found) =>
                    found !== undefined ? Effect.succeed(found) : Effect.fail(failure),
                  ),
                ),
            ),
          );
        });
        current = yield* withEnvironmentConfigLock(environmentId, ensureDomain).pipe(
          Effect.retry({
            while: (error) => error._tag === "RailwayCustomDomainCreateFailed",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
        );
      }

      if (current === undefined || isGone(current)) {
        return yield* new CustomDomainNotCreated({ domain, serviceId });
      }

      const observedPort = current.targetPort ?? undefined;
      const desiredPort = props.targetPort;
      if (desiredPort !== undefined && desiredPort !== observedPort) {
        yield* customDomainUpdate({
          environmentId: current.environmentId,
          id: current.id,
          targetPort: desiredPort,
        });
        current = (yield* getById(current.id, current.projectId ?? projectId)) ?? current;
      }

      return toAttrs(current, { projectId, environmentId });
    }),

    delete: Effect.fn(function* ({ output }) {
      const customDomainId = output.customDomainId;
      const projectId = output.projectId;
      if (customDomainId.length === 0) return;
      yield* customDomainDelete(customDomainId).pipe(
        Effect.catchTag("RailwayNotFound", () => Effect.void),
      );
      if (projectId.length > 0) {
        yield* waitUntilGone(customDomainId, projectId);
      }
    }),
  });
