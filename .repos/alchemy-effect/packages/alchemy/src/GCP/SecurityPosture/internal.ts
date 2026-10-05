import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as securityposture from "@distilled.cloud/gcp/securityposture_v1";
import * as Data from "effect/Data";
import type { GcpOpContext } from "@distilled.cloud/gcp/Protocol";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import { createPhysicalName } from "../../PhysicalName.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import { stripInternalLabels } from "../Labels.ts";
import { waitForOperation as waitForLongRunningOperation } from "../Operation.ts";

export const DEFAULT_LOCATION = "global";
export const DEFAULT_STATE = "DRAFT";
export const MAX_ID_LENGTH = 63;

export class SecuritypostureNotResolved extends Data.TaggedError(
  "GCP.SecurityPosture.NotResolved",
)<{
  name: string;
}> {}

export class SecuritypostureStillExists extends Data.TaggedError(
  "GCP.SecurityPosture.StillExists",
)<{
  name: string;
}> {}

export class OrganizationNotResolved extends Data.TaggedError(
  "GCP.SecurityPosture.OrganizationNotResolved",
)<{
  project: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const sanitizeId = (name: string, fallback = "posture"): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `${fallback[0] ?? "p"}${next}`;
  next = next.slice(0, MAX_ID_LENGTH).replace(/-+$/g, "");
  if (next.length === 0) next = fallback;
  if (!/[a-z0-9]$/.test(next)) {
    next = `${next.slice(0, MAX_ID_LENGTH - 1)}0`;
  }
  return next.slice(0, MAX_ID_LENGTH);
};

export const toPhysicalId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  fallback = "posture",
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return sanitizeId(explicit, fallback);
    if (existing !== undefined) return existing;
    return sanitizeId(
      yield* createPhysicalName({
        id,
        maxLength: MAX_ID_LENGTH,
        lowercase: true,
      }),
      fallback,
    );
  });

export const organizationParent = (value: string) =>
  value.startsWith("organizations/")
    ? value
    : `organizations/${lastSegment(value)}`;

export const organizationIdOf = (value: string) => lastSegment(value);

export const locationParent = (organization: string, location: string) =>
  `${organizationParent(organization)}/locations/${location}`;

export const parseName = (name: string, collection: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const collectionAt = parts.lastIndexOf(collection);
  const locationsAt = parts.lastIndexOf("locations");
  const orgsAt = parts.lastIndexOf("organizations");
  return {
    organization: orgsAt >= 0 && parts[orgsAt + 1] ? parts[orgsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : DEFAULT_LOCATION,
    id:
      collectionAt >= 0 && parts[collectionAt + 1]
        ? parts[collectionAt + 1]!
        : lastSegment(name),
    parent:
      collectionAt > 0
        ? parts.slice(0, collectionAt).join("/")
        : parts.slice(0, Math.max(0, parts.length - 1)).join("/"),
  };
};

export const userAnnotations = (
  annotations: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(annotations));

export const hasAlchemyAnnotationMap = (
  annotations: Record<string, string | undefined> | null | undefined,
) => Object.keys(annotations ?? {}).some((key) => key.startsWith("alchemy-"));

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const canonical = (value: unknown): unknown => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    return value.length === 0 ? undefined : value;
  }
  if (Array.isArray(value)) {
    const items = value.map(canonical).filter((item) => item !== undefined);
    return items.length === 0 ? undefined : items;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, canonical(item)] as const)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    if (entries.length === 0) return undefined;
    return Object.fromEntries(entries);
  }
  return undefined;
};

export const fingerprint = (value: unknown): string =>
  JSON.stringify(canonical(value) ?? null);

export const fieldMask = (fields: Array<string | false | undefined>) =>
  fields
    .filter((field): field is string => typeof field === "string")
    .join(",");

export const defaultPolicySets = (): securityposture.PolicySetList => [
  {
    policySetId: "alchemy",
    description: "alchemy default policy set",
    policies: [
      {
        policyId: "alchemy-sha",
        constraint: {
          securityHealthAnalyticsModule: {
            moduleName: "API_KEY_EXISTS",
            moduleEnablementState: "DISABLED",
          },
        },
      },
    ],
  },
];

export const desiredPolicySets = (
  policySets: securityposture.PolicySetList | undefined,
): securityposture.PolicySetList =>
  policySets && policySets.length > 0 ? policySets : defaultPolicySets();

/**
 * Wait on a Security Posture long-running operation (control-plane, usually under a minute).
 * `ALREADY_EXISTS` (a create race) counts as success; so does `NOT_FOUND`
 * when `notFoundOk` (deletes). Returns the final operation.
 */
export const waitForOperation = (
  operation: securityposture.Operation,
  options?: { notFoundOk?: boolean },
) =>
  Effect.suspend(() => {
    let latest = operation;
    return waitForLongRunningOperation(
      operation,
      (name) => {
        const get = securityposture
          .getOrganizationsLocationsOperations({ name })
          .pipe(
            Effect.tap((current) =>
              Effect.sync(() => {
                latest = current;
              }),
            ),
          );
        const observe: Effect.Effect<
          securityposture.Operation,
          securityposture.GetOrganizationsLocationsOperationsError,
          GcpOpContext
        > =
          options?.notFoundOk === true
            ? get.pipe(
                Effect.catchTag("NotFound", () =>
                  Effect.succeed<securityposture.Operation>({
                    name,
                    done: true,
                  }),
                ),
              )
            : get.pipe(
                // A just-returned operation can briefly 404 on read.
                Effect.retry({
                  while: (error) => error._tag === "NotFound",
                  times: 5,
                  schedule: Schedule.exponential("250 millis"),
                }),
              );
        return observe;
      },
      { budget: "10 minutes" },
    ).pipe(
      Effect.map(() => latest),
      // google.rpc.Code ALREADY_EXISTS = 6, NOT_FOUND = 5.
      Effect.catchTag("GCP.OperationFailed", (error) =>
        error.code === 6 || (options?.notFoundOk === true && error.code === 5)
          ? Effect.succeed(latest)
          : Effect.fail(error),
      ),
    );
  });

export const waitUntilExists = <A, E, R>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
): Effect.Effect<NonNullable<A>, E | SecuritypostureNotResolved, R> =>
  get.pipe(
    Effect.filterOrFail(
      (value): value is NonNullable<A> => value != null,
      () => new SecuritypostureNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) => error instanceof SecuritypostureNotResolved,
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

export const waitUntilGone = <A, E, R>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
): Effect.Effect<void, E | SecuritypostureStillExists, R> =>
  get.pipe(
    Effect.filterOrFail(
      (value) => value === undefined,
      () => new SecuritypostureStillExists({ name }),
    ),
    Effect.retry({
      while: (error) => error instanceof SecuritypostureStillExists,
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
    Effect.asVoid,
  );

const ancestryParent = (name: string) =>
  name.startsWith("projects/")
    ? resourcemanager.getProjects({ name }).pipe(
        Effect.map((resource) => resource.parent),
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
      )
    : name.startsWith("folders/")
      ? resourcemanager.getFolders({ name }).pipe(
          Effect.map((folder) => folder.parent),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        )
      : Effect.succeed(undefined);

export const tryResolveOrganization = () =>
  Effect.gen(function* () {
    const configured = Option.getOrUndefined(
      yield* Config.option(Config.String("GOOGLE_ORGANIZATION_ID")),
    )?.trim();
    if (configured) return organizationParent(configured);
    const env = yield* GcpEnvironment.current;
    let current: string | undefined = `projects/${env.project}`;
    for (let i = 0; i < 8; i++) {
      if (current === undefined) return undefined;
      if (current.startsWith("organizations/")) return current;
      current = yield* ancestryParent(current);
    }
    return undefined;
  });

export const resolveOrganization = (
  explicit: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return organizationParent(explicit);
    if (existing !== undefined) return organizationParent(existing);
    const resolved = yield* tryResolveOrganization();
    if (resolved === undefined) {
      const env = yield* GcpEnvironment.current;
      return yield* new OrganizationNotResolved({ project: env.project });
    }
    return resolved;
  });

export const projectNumberOf = (project: string) =>
  resourcemanager
    .getProjects({ name: `projects/${lastSegment(project)}` })
    .pipe(
      Effect.map((resource) => {
        const number = lastSegment(resource.name ?? "");
        return /^\d+$/.test(number) ? number : lastSegment(project);
      }),
      Effect.catchTag("NotFound", () => Effect.succeed(lastSegment(project))),
    );

export const normalizeTargetResource = (value: string) =>
  Effect.gen(function* () {
    if (value.startsWith("organizations/") || value.startsWith("folders/")) {
      return value;
    }
    if (value.startsWith("projects/")) {
      const id = lastSegment(value);
      if (/^\d+$/.test(id)) return value;
      const number = yield* projectNumberOf(id);
      return `projects/${number}`;
    }
    if (/^\d+$/.test(value)) return `projects/${value}`;
    const number = yield* projectNumberOf(value);
    return `projects/${number}`;
  });

export const defaultTargetResource = () =>
  Effect.gen(function* () {
    const env = yield* GcpEnvironment.current;
    const number = yield* projectNumberOf(env.project);
    return `projects/${number}`;
  });

export const replaceOnIdentity = (changed: boolean, deleteFirst: boolean) =>
  changed ? ({ action: "replace" as const, deleteFirst } as const) : undefined;
