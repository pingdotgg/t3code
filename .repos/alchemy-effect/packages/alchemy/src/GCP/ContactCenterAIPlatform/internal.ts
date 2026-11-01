import * as ccaip from "@distilled.cloud/gcp/contactcenteraiplatform_v1alpha1";
import { Retry as GcpRetry } from "@distilled.cloud/gcp/Retry";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import { tagRecord } from "../../Tags.ts";
import { stripInternalLabels } from "../Labels.ts";
import { isTransientGcpError } from "../Errors.ts";

const noRetryLayer = Layer.succeed(GcpRetry, { while: () => false });

export const DEFAULT_INSTANCE_SIZE = "DEV_SMALL";
export const MAX_ID_LENGTH = 63;
export const MAX_DOMAIN_PREFIX_LENGTH = 16;
export const MIN_DOMAIN_PREFIX_LENGTH = 2;

export class ContactCenterNotResolved extends Data.TaggedError(
  "GCP.ContactCenterAIPlatform.ContactCenterNotResolved",
)<{
  name: string;
}> {}

export class ContactCenterNotReady extends Data.TaggedError(
  "GCP.ContactCenterAIPlatform.ContactCenterNotReady",
)<{
  name: string;
  state: string;
}> {}

export class ContactCenterFailed extends Data.TaggedError(
  "GCP.ContactCenterAIPlatform.ContactCenterFailed",
)<{
  name: string;
  state: string;
}> {}

export class ContactCenterStillExists extends Data.TaggedError(
  "GCP.ContactCenterAIPlatform.ContactCenterStillExists",
)<{
  name: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const locationParent = (project: string, location: string) =>
  `projects/${project}/locations/${location}`;

export const normalizeLocation = (
  location: string | undefined,
  defaultLocation: string,
) => lastSegment(location ?? defaultLocation).toLowerCase();

export const rfc1035 = (
  name: string,
  maxLength: number,
  fallback: string,
): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `${fallback[0] ?? "c"}${next}`;
  next = next.slice(0, maxLength).replace(/-+$/g, "");
  if (next.length === 0) return fallback.slice(0, maxLength);
  if (!/[a-z0-9]$/.test(next)) {
    next = `${next.slice(0, maxLength - 1)}0`;
  }
  return next.slice(0, maxLength);
};

export const domainPrefixOf = (name: string): string => {
  const next = rfc1035(name, MAX_DOMAIN_PREFIX_LENGTH, "cc");
  return next.length >= MIN_DOMAIN_PREFIX_LENGTH
    ? next
    : `${next}x`.slice(0, MAX_DOMAIN_PREFIX_LENGTH);
};

export const toPhysicalId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return rfc1035(explicit, MAX_ID_LENGTH, "cc");
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: MAX_ID_LENGTH,
        lowercase: true,
      }),
      MAX_ID_LENGTH,
      "cc",
    );
  });

export const toDomainPrefix = (
  explicit: string | undefined,
  existing: string | undefined,
  id: string,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return domainPrefixOf(explicit);
    if (existing !== undefined) return existing;
    return domainPrefixOf(
      yield* createPhysicalName({
        id,
        maxLength: MAX_DOMAIN_PREFIX_LENGTH,
        lowercase: true,
      }),
    );
  });

export const parseName = (name: string, defaultLocation: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const collectionAt = parts.lastIndexOf("contactCenters");
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : defaultLocation,
    id:
      collectionAt >= 0 && parts[collectionAt + 1]
        ? parts[collectionAt + 1]!
        : lastSegment(name),
  };
};

export const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

export const hasAlchemyLabelMap = (
  labels: Record<string, string | undefined> | null | undefined,
) => Object.keys(labels ?? {}).some((key) => key.startsWith("alchemy-"));

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

export const sameJson = (left: unknown, right: unknown) =>
  fingerprint(left) === fingerprint(right);

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const sameBool = (
  left: boolean | undefined,
  right: boolean | undefined,
) => (left === true) === (right === true);

export const updateMaskOf = (...fields: Array<string | false | undefined>) =>
  fields
    .filter((field): field is string => typeof field === "string")
    .join(",");

export const replaceOnIdentity = (input: {
  previousId?: string;
  nextId?: string;
  previousLocation?: string;
  nextLocation?: string;
  extra?: boolean;
}) => {
  if (input.extra === true) {
    return { action: "replace" as const, deleteFirst: false };
  }
  if (
    input.previousId !== undefined &&
    input.nextId !== undefined &&
    input.previousId !== input.nextId
  ) {
    return { action: "replace" as const, deleteFirst: false };
  }
  if (
    input.previousLocation !== undefined &&
    input.nextLocation !== undefined &&
    input.previousLocation !== input.nextLocation
  ) {
    return { action: "replace" as const, deleteFirst: false };
  }
  return undefined;
};

export const retryTransient = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: isTransientGcpError,
      times: 8,
      schedule: Schedule.exponential("250 millis"),
    }),
  );

export const waitUntilExists = <A, E extends { readonly _tag: string }, R>(
  get: Effect.Effect<A, E, R>,
  name: string,
): Effect.Effect<Exclude<A, undefined>, E | ContactCenterNotResolved, R> =>
  get.pipe(
    Effect.filterOrFail(
      (value): value is Exclude<A, undefined> => value !== undefined,
      () => new ContactCenterNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.ContactCenterAIPlatform.ContactCenterNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

export const waitUntilGone = <A, E extends { readonly _tag: string }, R>(
  get: Effect.Effect<A, E, R>,
  name: string,
): Effect.Effect<void, E | ContactCenterStillExists, R> =>
  get.pipe(
    Effect.filterOrFail(
      (value) => value === undefined,
      () => new ContactCenterStillExists({ name }),
    ),
    Effect.asVoid,
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.ContactCenterAIPlatform.ContactCenterStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const FAILED_STATES = new Set(["STATE_FAILED", "STATE_TERMINATING_FAILED"]);

const READY_STATES = new Set([
  "STATE_DEPLOYED",
  "STATE_IN_GRACE_PERIOD",
  "STATE_DEGRADED",
]);

export const isTerminated = (state: string | undefined) =>
  (state ?? "").toUpperCase() === "STATE_TERMINATED";

const stateOfUpper = (state: string | undefined) => (state ?? "").toUpperCase();

export const waitUntilReady = <A, E extends { readonly _tag: string }, R>(
  get: Effect.Effect<A, E, R>,
  name: string,
  stateOf: (value: Exclude<A, undefined>) => string | undefined,
): Effect.Effect<
  Exclude<A, undefined>,
  E | ContactCenterNotResolved | ContactCenterFailed | ContactCenterNotReady,
  R
> =>
  get.pipe(
    Effect.filterOrFail(
      (value): value is Exclude<A, undefined> => value !== undefined,
      () => new ContactCenterNotResolved({ name }),
    ),
    Effect.filterOrFail(
      (value) => !FAILED_STATES.has(stateOfUpper(stateOf(value))),
      (value) =>
        new ContactCenterFailed({
          name,
          state: stateOfUpper(stateOf(value)),
        }),
    ),
    Effect.filterOrFail(
      (value) => READY_STATES.has(stateOfUpper(stateOf(value))),
      (value) =>
        new ContactCenterNotReady({
          name,
          state: stateOfUpper(stateOf(value)),
        }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.ContactCenterAIPlatform.ContactCenterNotReady" ||
        error._tag === "GCP.ContactCenterAIPlatform.ContactCenterNotResolved",
      times: 10,
      schedule: Schedule.spaced("8 seconds"),
    }),
  );

export const releaseChannelOf = (
  item: Pick<ccaip.ContactCenter, "early" | "normal" | "critical">,
): "early" | "normal" | "critical" | undefined => {
  if (item.critical !== undefined) return "critical";
  if (item.early !== undefined) return "early";
  if (item.normal !== undefined) return "normal";
  return undefined;
};

const emptyContactCenters = Effect.succeed<ccaip.ContactCenter[]>([]);

export const listContactCenters = (parent: string) =>
  parent.length === 0
    ? emptyContactCenters
    : ccaip.listProjectsLocationsContactCenters
        .pages({ parent, pageSize: 1000 })
        .pipe(
          Stream.flatMap((page) =>
            Stream.fromIterable(page.contactCenters ?? []),
          ),
          Stream.filter((item) => hasAlchemyLabelMap(item.labels)),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.provide(noRetryLayer),
          Effect.catchTag("NotFound", () => emptyContactCenters),
        );

const FALLBACK_LOCATIONS = [
  "us-central1",
  "us-east1",
  "europe-west1",
  "asia-southeast1",
] as const;

const listLocationIds = (project: string) =>
  ccaip.listProjectsLocations
    .pages({ name: `projects/${project}`, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.locations ?? [])),
      Stream.map(
        (location) => location.locationId || lastSegment(location.name ?? ""),
      ),
      Stream.filter((id) => id.length > 0 && id !== "-"),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(new Set(chunk))),
    );

const listAcrossLocations = (project: string, region: string) =>
  Effect.gen(function* () {
    const discovered = yield* listLocationIds(project);
    const locations =
      discovered.length > 0
        ? discovered
        : [...new Set([region, ...FALLBACK_LOCATIONS])];
    const pages = yield* Effect.forEach(
      locations,
      (location) => listContactCenters(locationParent(project, location)),
      { concurrency: 4 },
    );
    return pages.flat();
  });

export const listOwnedContactCenters = (project: string, region: string) =>
  listContactCenters(`projects/${project}/locations/-`).pipe(
    Effect.catchIf(
      (error) =>
        error._tag === "ServiceUnavailable" ||
        error._tag === "InternalServerError" ||
        error._tag === "BadGateway" ||
        error._tag === "GatewayTimeout",
      () => listAcrossLocations(project, region),
    ),
  );
