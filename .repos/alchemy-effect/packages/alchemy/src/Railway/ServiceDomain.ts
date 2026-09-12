import type { DomainsResponseServiceDomainsItem } from "@distilled.cloud/railway";
import * as railway from "@distilled.cloud/railway";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { sanitizeRailwayName } from "./Metadata.ts";
import { factory as retryFactory } from "./RetryPolicy.ts";
import { withEnvironmentConfigLock } from "./transient.ts";

/**
 * A Railway-generated `*.up.railway.app` hostname on a Service. Created
 * with `serviceDomainCreate`. Distinct from {@link CustomDomain} (a user
 * hostname).
 */
export type ServiceDomainRecord = {
  id: string;
  domain: string;
  serviceId: string;
  environmentId: string;
  projectId: string | undefined;
  targetPort: number | undefined;
  syncStatus: string;
  url: string;
};

export class ServiceDomainNotCreated extends Data.TaggedError(
  "Railway.ServiceDomainNotCreated",
)<{
  serviceId: string;
  environmentId: string;
}> {}

type CloudDomain = DomainsResponseServiceDomainsItem;

const isGone = (domain: CloudDomain | undefined) =>
  domain === undefined ||
  domain.deletedAt != null ||
  domain.syncStatus === "DELETED" ||
  domain.syncStatus === "DELETING";

const toRecord = (domain: CloudDomain): ServiceDomainRecord => ({
  id: domain.id,
  domain: domain.domain,
  serviceId: domain.serviceId,
  environmentId: domain.environmentId,
  projectId: domain.projectId ?? undefined,
  targetPort: domain.targetPort ?? undefined,
  syncStatus: domain.syncStatus,
  url: `https://${domain.domain}`,
});

const alreadyExists = (message: string) =>
  /already exists|already in use|already taken|duplicate/i.test(message);

export const listServiceDomains = (
  projectId: string,
  environmentId: string,
  serviceId: string,
) =>
  railway.domains({ environmentId, projectId, serviceId }).pipe(
    Effect.map((result) =>
      result.serviceDomains.filter((domain) => !isGone(domain)),
    ),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
      Effect.succeed([] as DomainsResponseServiceDomainsItem[]),
    ),
  );

const findCloudDomainById = (input: {
  projectId: string;
  environmentId: string;
  serviceId: string;
  domainId: string;
}) =>
  railway
    .domains({
      projectId: input.projectId,
      environmentId: input.environmentId,
      serviceId: input.serviceId,
    })
    .pipe(
      Effect.map((result) =>
        result.serviceDomains.find(
          (candidate) => candidate.id === input.domainId,
        ),
      ),
      Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
        Effect.succeed(undefined),
      ),
    );

export const findServiceDomainById = Effect.fn(function* (input: {
  projectId: string;
  environmentId: string;
  serviceId: string;
  domainId: string;
}) {
  const domain = yield* findCloudDomainById(input);
  return domain === undefined || isGone(domain) ? undefined : toRecord(domain);
});

export const deleteServiceDomainById = Effect.fn(function* (input: {
  projectId: string;
  environmentId: string;
  serviceId: string;
  domainId: string;
}) {
  yield* deleteOwnedServiceDomain(input);
});

/**
 * Remove the owned generated domain. Environment config is the source of
 * truth (`serviceDomains[id]: null`); GraphQL delete is the fallback.
 * Matches the recorded id and, if that id is missing from the live list,
 * the recorded hostname — never every generated domain.
 */
export const deleteOwnedServiceDomain = Effect.fn(function* (input: {
  projectId: string;
  environmentId: string;
  serviceId: string;
  domainId?: string;
  domain?: string;
}) {
  if (input.domainId === undefined && input.domain === undefined) return;

  const live = yield* listServiceDomains(
    input.projectId,
    input.environmentId,
    input.serviceId,
  );
  const owned = live.filter(
    (row) =>
      (input.domainId !== undefined && row.id === input.domainId) ||
      (input.domain !== undefined && row.domain === input.domain),
  );
  const keys = new Set<string>([
    ...(input.domainId !== undefined ? [input.domainId] : []),
    ...owned.map((row) => row.id),
  ]);
  if (keys.size === 0) return;

  yield* withEnvironmentConfigLock(
    input.environmentId,
    railway.environmentPatchCommit({
      environmentId: input.environmentId,
      commitMessage: "Remove Railway service domain",
      patch: {
        services: {
          [input.serviceId]: {
            networking: {
              serviceDomains: Object.fromEntries(
                [...keys].map((id) => [id, null]),
              ),
            },
          },
        },
      },
    }),
  ).pipe(Effect.ignore);

  for (const row of owned) {
    if (row.syncStatus === "DELETING") continue;
    yield* withEnvironmentConfigLock(
      input.environmentId,
      railway.deleteServiceDomain({ id: row.id }),
    ).pipe(
      Effect.catchTag(["RailwayNotFound", "NotFound"], () => Effect.void),
      Effect.asVoid,
    );
  }

  const gone = yield* listServiceDomains(
    input.projectId,
    input.environmentId,
    input.serviceId,
  ).pipe(
    Effect.map(
      (rows) =>
        !rows.some(
          (row) =>
            keys.has(row.id) ||
            (input.domain !== undefined && row.domain === input.domain),
        ),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (deleted) => deleted,
      times: 12,
    }),
  );
  if (!gone) {
    return yield* new ServiceDomainNotCreated({
      serviceId: input.serviceId,
      environmentId: input.environmentId,
    });
  }
});

const listedOrUndefined = (input: {
  projectId: string;
  environmentId: string;
  serviceId: string;
  domainId?: string | null;
}) =>
  listServiceDomains(
    input.projectId,
    input.environmentId,
    input.serviceId,
  ).pipe(
    Effect.map((rows) =>
      input.domainId === undefined
        ? (rows[0] as CloudDomain | undefined)
        : input.domainId === null
          ? undefined
          : rows.find((domain) => domain.id === input.domainId),
    ),
  );

/**
 * Railway's own IaC compiler writes generated domains through
 * `environmentPatchCommit` as `services[id].networking.serviceDomains[uuid]`.
 * The GraphQL `serviceDomainCreate` mutation is a convenience wrapper the
 * CLI also uses; the patch is what `.railway/railway.ts` apply goes through
 * (and what the environment schema documents as "make publicly accessible
 * over HTTP").
 *
 * @see https://backboard.railway.com/schema/environment.schema.json
 */
const createViaEnvironmentPatch = (input: {
  environmentId: string;
  serviceId: string;
}) =>
  Effect.gen(function* () {
    const domainKey = yield* Effect.sync(() => crypto.randomUUID());
    yield* withEnvironmentConfigLock(
      input.environmentId,
      railway.environmentPatchCommit({
        environmentId: input.environmentId,
        commitMessage: "Generate Railway service domain",
        patch: {
          services: {
            [input.serviceId]: {
              networking: {
                serviceDomains: {
                  [domainKey]: {},
                },
              },
            },
          },
        },
      }),
    ).pipe(Effect.ignore);
    return domainKey;
  });

/**
 * Official CLI / public-API mutation. Same input as
 * `railway domain` (`environmentId` + `serviceId`; optional `targetPort`
 * is omitted on create — pinning a port while PORT is set makes Railway
 * reject the mutation).
 *
 * @see https://docs.railway.com/integrations/api/manage-domains
 */
/**
 * Hand `RailwayServiceDomainCreateFailed` straight to the manual handling
 * (which falls back to observing an actually-created domain) instead of
 * blindly retrying it, while KEEPING the default retry for every other
 * transient error — a plain `Retry.none` also disabled throttling retries,
 * so suite-wide 429s escaped this mutation unretried.
 */
const domainCreateRetry = railway.Retry.policy((lastError) => {
  const base = retryFactory(lastError);
  return {
    while: (error) =>
      !(error instanceof railway.RailwayServiceDomainCreateFailed) &&
      (base.while?.(error) ?? false),
    schedule: base.schedule,
  };
});

const waitForServiceDomainById = (input: {
  projectId: string;
  environmentId: string;
  serviceId: string;
  domainId: string;
}) =>
  findCloudDomainById(input).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (domain) => domain !== undefined && !isGone(domain),
      times: 8,
    }),
    Effect.map((domain) =>
      domain !== undefined && !isGone(domain) ? domain : undefined,
    ),
  );

/**
 * The environment-config map key is supposed to be the GraphQL domain id,
 * but the live `domains` list can lag or mint a different id. Prefer the
 * patch key; otherwise take a domain that was not in the pre-patch set so
 * we do not claim a foreign generated domain and do not `serviceDomainCreate`
 * a second hostname.
 */
const waitForNewServiceDomain = (input: {
  projectId: string;
  environmentId: string;
  serviceId: string;
  preferId: string;
  preexistingIds: ReadonlySet<string>;
}) =>
  listServiceDomains(
    input.projectId,
    input.environmentId,
    input.serviceId,
  ).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (rows) =>
        rows.some(
          (domain) =>
            domain.id === input.preferId ||
            !input.preexistingIds.has(domain.id),
        ),
      times: 15,
    }),
    Effect.map(
      (rows) =>
        rows.find((domain) => domain.id === input.preferId) ??
        rows.find((domain) => !input.preexistingIds.has(domain.id)),
    ),
  );

const createViaMutation = (input: {
  projectId: string;
  environmentId: string;
  serviceId: string;
  domainId?: string;
}) => {
  const listed =
    input.domainId === undefined
      ? listedOrUndefined(input)
      : waitForServiceDomainById({ ...input, domainId: input.domainId });
  const missing = () =>
    new ServiceDomainNotCreated({
      serviceId: input.serviceId,
      environmentId: input.environmentId,
    });
  const listedOrFail = <E>(error: E) =>
    listed.pipe(
      Effect.flatMap((row) =>
        row !== undefined ? Effect.succeed(row) : Effect.fail(error),
      ),
    );
  const create = railway
    .createServiceDomain({
      input: {
        environmentId: input.environmentId,
        serviceId: input.serviceId,
      },
    })
    .pipe(domainCreateRetry)
    .pipe(
      Effect.flatMap((created) =>
        input.domainId === undefined
          ? listedOrFail(missing())
          : Effect.succeed(created),
      ),
      Effect.catchTag("RailwayServiceDomainCreateFailed", (error) =>
        listedOrFail(error),
      ),
      Effect.catchTag("RailwayNotFound", (error) =>
        input.domainId !== undefined &&
        error.message.includes("ServiceInstance not found")
          ? listedOrFail(error)
          : Effect.fail(error),
      ),
      Effect.catchTag("RailwayValidationError", (error) =>
        input.domainId !== undefined || alreadyExists(error.message)
          ? listedOrFail(error)
          : Effect.fail(error),
      ),
      Effect.catchTag("Conflict", () => listedOrFail(missing())),
    );

  return withEnvironmentConfigLock(input.environmentId, create).pipe(
    Effect.retry({
      while: (error) =>
        (input.domainId === undefined &&
          error._tag === "RailwayServiceDomainCreateFailed") ||
        (error._tag === "RailwayNotFound" &&
          error.message.includes("ServiceInstance not found")),
      times: 12,
      schedule: Schedule.spaced("5 seconds"),
    }),
  );
};

/**
 * Terraform `railway_service_domain` requires `subdomain` and, after
 * create, immediately `serviceDomainUpdate`s to `{subdomain}.{suffix}`.
 * Create itself cannot take a subdomain — the GraphQL input only has
 * `environmentId` / `serviceId` / optional `targetPort`.
 *
 * @see https://github.com/terraform-community-providers/terraform-provider-railway/blob/master/internal/provider/resource_service_domain.go
 */
const desiredDomainName = (input: {
  subdomain: string | undefined;
  suffix: string | null | undefined;
}) => {
  if (input.subdomain === undefined || input.subdomain.length === 0) {
    return undefined;
  }
  if (
    input.suffix === undefined ||
    input.suffix === null ||
    input.suffix.length === 0
  ) {
    return undefined;
  }
  const subdomain = sanitizeRailwayName(input.subdomain);
  return `${subdomain}.${input.suffix}`;
};

const syncDomain = (input: {
  current: CloudDomain;
  subdomain: string | undefined;
  targetPort: number | undefined;
}) => {
  const domainName = desiredDomainName({
    subdomain: input.subdomain,
    suffix: input.current.suffix,
  });
  const observedPort = input.current.targetPort ?? undefined;
  const rename =
    domainName !== undefined && domainName !== input.current.domain;
  const retarget =
    input.targetPort !== undefined && input.targetPort !== observedPort;
  if (!rename && !retarget) return Effect.succeed(undefined);
  return withEnvironmentConfigLock(
    input.current.environmentId,
    railway.updateServiceDomain({
      input: {
        domain: domainName ?? input.current.domain,
        environmentId: input.current.environmentId,
        serviceDomainId: input.current.id,
        serviceId: input.current.serviceId,
        ...(retarget ? { targetPort: input.targetPort } : {}),
      },
    }),
  ).pipe(Effect.ignore);
};

/**
 * Observe-ensure-sync a generated `*.up.railway.app` domain. Creates one
 * when missing (environment-config patch, then the public mutation),
 * claims a stable `{subdomain}.{suffix}` like Terraform, updates
 * `targetPort` in place, and returns the live record.
 *
 * Create itself cannot take a subdomain — Railway assigns
 * `{serviceName}-{environmentName}.up.railway.app`. That first DNS label
 * must be ≤ 63 characters or the API returns "please try again". Extra
 * environments are capped at 24 chars so a 32-char service still fits.
 */
export const ensureServiceDomain = Effect.fn(function* (input: {
  projectId: string;
  environmentId: string;
  serviceId: string;
  domainId?: string | null;
  /** DNS label claimed via `serviceDomainUpdate`, Terraform-style. */
  subdomain?: string;
  targetPort?: number;
}) {
  let current: CloudDomain | undefined = yield* listedOrUndefined(input);

  let createdDomainId: string | undefined;
  if (current === undefined) {
    const preexisting = yield* listServiceDomains(
      input.projectId,
      input.environmentId,
      input.serviceId,
    );
    createdDomainId = yield* createViaEnvironmentPatch({
      environmentId: input.environmentId,
      serviceId: input.serviceId,
    });
    current = yield* waitForNewServiceDomain({
      projectId: input.projectId,
      environmentId: input.environmentId,
      serviceId: input.serviceId,
      preferId: createdDomainId,
      preexistingIds: new Set(preexisting.map((domain) => domain.id)),
    });
  }

  if (current === undefined) {
    if (input.domainId === undefined) {
      current = yield* createViaMutation({
        projectId: input.projectId,
        environmentId: input.environmentId,
        serviceId: input.serviceId,
      });
    } else {
      const domainId = createdDomainId;
      if (domainId === undefined) {
        return yield* new ServiceDomainNotCreated({
          serviceId: input.serviceId,
          environmentId: input.environmentId,
        });
      }
      current = yield* createViaMutation({ ...input, domainId });
    }
  }

  if (current === undefined || isGone(current)) {
    return yield* new ServiceDomainNotCreated({
      serviceId: input.serviceId,
      environmentId: input.environmentId,
    });
  }

  yield* syncDomain({
    current,
    subdomain: input.subdomain,
    targetPort: input.targetPort,
  });

  current =
    (yield* listedOrUndefined({ ...input, domainId: current.id })) ?? current;

  if (current === undefined || isGone(current)) {
    return yield* new ServiceDomainNotCreated({
      serviceId: input.serviceId,
      environmentId: input.environmentId,
    });
  }

  return toRecord(current);
});
