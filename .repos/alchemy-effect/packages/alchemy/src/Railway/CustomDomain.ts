import type {
  CustomDomainCreateResponse,
  CustomDomainResponse,
  DomainsResponseCustomDomainsItem,
} from "@distilled.cloud/railway";
import * as railway from "@distilled.cloud/railway";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { matchesAlchemyPhysicalName } from "./Metadata.ts";
import { ownedProjects, projectEnvironmentIds } from "./Project.ts";
import type { Providers } from "./Providers.ts";

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
export type CustomDomainService = {
  readonly serviceId: string;
  readonly projectId?: string;
};

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
 * CustomDomain next to the Service. Point DNS at the values in
 * `verificationDnsHost` / `verificationToken`.
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
 * import * as Railway from "alchemy/Railway";
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
 */
export const CustomDomain = Resource<CustomDomain>("Railway.CustomDomain");

export class CustomDomainNotCreated extends Data.TaggedError(
  "Railway.CustomDomainNotCreated",
)<{
  domain: string;
  serviceId: string;
}> {}

export class CustomDomainServiceMissing extends Data.TaggedError(
  "Railway.CustomDomainServiceMissing",
)<{
  domain: string;
}> {}

type CloudDomain =
  | CustomDomainResponse
  | CustomDomainCreateResponse
  | DomainsResponseCustomDomainsItem;

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
  domain === undefined ||
  domain.deletedAt != null ||
  domain.syncStatus === "DELETED";

const toAttrs = (
  domain: CloudDomain,
  fallback?: { projectId?: string; environmentId?: string },
): CustomDomain["Attributes"] => {
  const status = "status" in domain ? domain.status : undefined;
  const name = domain.domain;
  return {
    customDomainId: domain.id,
    domain: name,
    serviceId: domain.serviceId,
    projectId: domain.projectId ?? fallback?.projectId ?? "",
    environmentId: domain.environmentId || fallback?.environmentId || "",
    targetPort: domain.targetPort ?? undefined,
    verified: status?.verified,
    certificateStatus: status?.certificateStatus,
    certificateErrorMessage: status?.certificateErrorMessage ?? undefined,
    verificationDnsHost: status?.verificationDnsHost ?? undefined,
    verificationToken: status?.verificationToken ?? undefined,
    syncStatus: domain.syncStatus,
    url: `https://${name}`,
  };
};

const getById = (customDomainId: string, projectId: string) =>
  railway.customDomain({ id: customDomainId, projectId }).pipe(
    Effect.map((domain) => (isGone(domain) ? undefined : domain)),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
      Effect.succeed(undefined),
    ),
  );

const listServiceDomains = (
  projectId: string,
  environmentId: string,
  serviceId: string,
) =>
  railway.domains({ environmentId, projectId, serviceId }).pipe(
    Effect.map((result) =>
      result.customDomains.filter((domain) => !isGone(domain)),
    ),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
      Effect.succeed([] as DomainsResponseCustomDomainsItem[]),
    ),
  );

const findByDomain = (
  projectId: string,
  environmentId: string,
  serviceId: string,
  domain: string,
) =>
  listServiceDomains(projectId, environmentId, serviceId).pipe(
    Effect.map((domains) =>
      domains.find(
        (item) => item.domain.toLowerCase() === domain.toLowerCase(),
      ),
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

const alreadyExists = (message: string) =>
  /already exists|already in use|already taken|duplicate/i.test(message);

const waitUntilGone = (customDomainId: string, projectId: string) =>
  getById(customDomainId, projectId).pipe(
    Effect.map((domain) => domain === undefined),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (gone) => gone,
      times: 8,
    }),
  );

export const CustomDomainProvider = () =>
  Provider.succeed(CustomDomain, {
    stables: [
      "customDomainId",
      "serviceId",
      "projectId",
      "environmentId",
      "domain",
    ],
    nuke: { dependsOn: ["Railway.Project"] },

    list: Effect.fn(function* () {
      const projects = yield* ownedProjects();
      const rows = yield* Effect.forEach(projects, (project) =>
        Effect.gen(function* () {
          const live = yield* railway
            .project({ id: project.projectId })
            .pipe(
              Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
                Effect.succeed(undefined),
              ),
            );
          const services = (
            live?.services.edges.map((edge) => edge.node) ?? []
          ).filter(
            (service) =>
              service.deletedAt == null &&
              matchesAlchemyPhysicalName(service.name),
          );
          const envIds = yield* projectEnvironmentIds(project);
          const nested = yield* Effect.forEach(services, (service) =>
            Effect.forEach(envIds, (environmentId) =>
              listServiceDomains(
                project.projectId,
                environmentId,
                service.id,
              ).pipe(
                Effect.map((domains) =>
                  domains.map((domain) =>
                    toAttrs(domain, {
                      projectId: project.projectId,
                      environmentId,
                    }),
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
      const serviceChanged =
        serviceId !== undefined && serviceId !== output.serviceId;
      const environmentId = environmentIdOf(news.environment);
      const environmentChanged =
        environmentId !== undefined && environmentId !== output.environmentId;
      const domainChanged =
        news.domain.toLowerCase() !== output.domain.toLowerCase();
      if (serviceChanged || environmentChanged || domainChanged) {
        return {
          action: "replace" as const,
          deleteFirst: !domainChanged,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const serviceId = output?.serviceId ?? serviceIdOf(olds?.service) ?? "";
      const projectId =
        output?.projectId ??
        projectIdOf(olds?.service) ??
        projectIdOf(olds?.environment) ??
        "";
      const environmentId =
        output?.environmentId ?? environmentIdOf(olds?.environment) ?? "";
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
        projectIdOf(props.service) ??
        projectIdOf(props.environment) ??
        output?.projectId ??
        "";
      const environmentId =
        environmentIdOf(props.environment) ?? output?.environmentId ?? "";
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
        current = yield* observe({
          projectId,
          environmentId,
          serviceId,
          domain,
        });
      }

      if (current === undefined) {
        const created = yield* railway
          .customDomainCreate({
            input: {
              domain,
              environmentId,
              projectId,
              serviceId,
              ...(props.targetPort !== undefined
                ? { targetPort: props.targetPort }
                : {}),
            },
          })
          .pipe(
            Effect.catchTag("RailwayValidationError", (e) =>
              alreadyExists(e.message)
                ? Effect.succeed(undefined)
                : Effect.fail(e),
            ),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        current =
          created ??
          (yield* observe({
            projectId,
            environmentId,
            serviceId,
            domain,
          }));
      }

      if (current === undefined || isGone(current)) {
        return yield* new CustomDomainNotCreated({ domain, serviceId });
      }

      const observedPort = current.targetPort ?? undefined;
      const desiredPort = props.targetPort;
      if (desiredPort !== undefined && desiredPort !== observedPort) {
        yield* railway.customDomainUpdate({
          environmentId: current.environmentId,
          id: current.id,
          targetPort: desiredPort,
        });
        current =
          (yield* getById(current.id, current.projectId ?? projectId)) ??
          current;
      }

      return toAttrs(current, { projectId, environmentId });
    }),

    delete: Effect.fn(function* ({ output }) {
      const customDomainId = output.customDomainId;
      const projectId = output.projectId;
      if (customDomainId.length === 0) return;
      yield* railway
        .customDomainDelete({ id: customDomainId })
        .pipe(
          Effect.catchTag(["RailwayNotFound", "NotFound"], () => Effect.void),
        );
      if (projectId.length > 0) {
        yield* waitUntilGone(customDomainId, projectId);
      }
    }),
  });
