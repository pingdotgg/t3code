import * as appengine from "@distilled.cloud/gcp/appengine_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";
import { GcpEnvironment } from "../Environment.ts";

// App Engine location ids (`us-central`, `europe-west`) are not Compute regions, and the app's own locationId wins.
export const DEFAULT_LOCATION = "us-central";
export const DEFAULT_SERVICE = "default";
export const DEFAULT_ACTION = "ALLOW";
export const DEFAULT_SOURCE_RANGE = "*";
export const DEFAULT_SSL_MANAGEMENT = "AUTOMATIC";
export const MAX_DISPLAY_NAME_LENGTH = 100;
export const MAX_DESCRIPTION_LENGTH = 400;
export const MAX_VERSION_ID_LENGTH = 63;
export const OWNERSHIP_ENV = "ALCHEMY_OWNERSHIP";
export const CATCH_ALL_PRIORITY = 2147483647;

export class ApplicationNotResolved extends Data.TaggedError(
  "GCP.AppEngine.ApplicationNotResolved",
)<{
  appsId: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const jsonEqual = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const updateMaskOf = (...fields: Array<string | undefined>) =>
  fields.filter((field): field is string => field !== undefined).join(",");

const markerOf = (
  _labels: Record<string, string>,
  stack: string,
  stage: string,
  id: string,
) =>
  `[alchemy ${alchemyLabelKeys.stack}=${stack} ${alchemyLabelKeys.stage}=${stage} ${alchemyLabelKeys.id}=${id}]`;

const fitMarker = (labels: Record<string, string>, maxLength: number) => {
  let stack = labels[alchemyLabelKeys.stack] ?? "x";
  let stage = labels[alchemyLabelKeys.stage] ?? "x";
  let id = labels[alchemyLabelKeys.id] ?? "x";
  let marker = markerOf(labels, stack, stage, id);
  while (
    marker.length > maxLength &&
    (stack.length > 1 || stage.length > 1 || id.length > 1)
  ) {
    if (stack.length >= stage.length && stack.length >= id.length) {
      stack = stack.slice(0, -1);
    } else if (stage.length >= id.length) {
      stage = stage.slice(0, -1);
    } else {
      id = id.slice(0, -1);
    }
    marker = markerOf(labels, stack, stage, id);
  }
  return marker.slice(0, maxLength);
};

export const encodeOwnership = (
  labels: Record<string, string>,
  text: string | undefined,
  maxLength = 8000,
): string => {
  const trimmed = text?.trim();
  if (!trimmed) return fitMarker(labels, maxLength);
  const minMarker = 24;
  const reserved = Math.min(
    trimmed.length + 1,
    Math.max(0, maxLength - minMarker),
  );
  const marker = fitMarker(labels, maxLength - reserved);
  return `${marker} ${trimmed}`.slice(0, maxLength);
};

export const parseOwnership = (
  text: string | undefined,
): {
  labels: Record<string, string>;
  text: string | undefined;
} => {
  if (!text?.startsWith("[alchemy ")) {
    return { labels: {}, text };
  }
  const end = text.indexOf("]");
  if (end < 0) return { labels: {}, text };
  const labels: Record<string, string> = {};
  for (const part of text.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = text.slice(end + 1).replace(/^[\s\n]+/, "");
  return { labels, text: rest.length > 0 ? rest : undefined };
};

export const hasOwnershipMarker = (text: string | undefined) =>
  Object.keys(parseOwnership(text).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

const prefixMatch = (expected: string, observed: string) =>
  expected === observed ||
  expected.startsWith(observed) ||
  observed.startsWith(expected);

export const ownedByAlchemy = (id: string, text: string | undefined) =>
  Effect.gen(function* () {
    const expected = yield* createInternalLabels(id);
    const { labels } = parseOwnership(text);
    if (!hasOwnershipMarker(text)) return false;
    const exact = yield* hasAlchemyLabels(id, labels);
    if (exact) return true;
    return (
      prefixMatch(
        expected[alchemyLabelKeys.stack] ?? "",
        labels[alchemyLabelKeys.stack] ?? "",
      ) &&
      prefixMatch(
        expected[alchemyLabelKeys.stage] ?? "",
        labels[alchemyLabelKeys.stage] ?? "",
      ) &&
      prefixMatch(
        expected[alchemyLabelKeys.id] ?? "",
        labels[alchemyLabelKeys.id] ?? "",
      )
    );
  });

export const ownershipLabels = (id: string) => createInternalLabels(id);

export const rfc1035 = (name: string, maxLength: number): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (!/^[a-z]/.test(next)) next = `v${next}`;
  if (next.startsWith("ah-") || next === "default" || next === "latest") {
    next = `v-${next}`;
  }
  next = next.slice(0, maxLength).replace(/-+$/, "");
  return next.length > 0 ? next : "version";
};

export const toResourceId = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
  maxLength = MAX_VERSION_ID_LENGTH,
) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.length > 0) return requested;
    if (existing !== undefined && existing.length > 0) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength,
        lowercase: true,
      }),
      maxLength,
    );
  });

export const toDisplayName = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.length > 0) {
      return requested.slice(0, MAX_DISPLAY_NAME_LENGTH);
    }
    if (existing !== undefined && existing.length > 0) {
      return existing.slice(0, MAX_DISPLAY_NAME_LENGTH);
    }
    return yield* toResourceId(id, undefined, undefined, 40);
  });

export const toPriority = (
  id: string,
  requested: number | undefined,
  existing: number | undefined,
) =>
  Effect.gen(function* () {
    if (requested !== undefined) return requested;
    if (existing !== undefined) return existing;
    const name = yield* createPhysicalName({
      id,
      maxLength: 32,
      lowercase: true,
    });
    let hash = 2166136261;
    for (const ch of name) {
      hash ^= ch.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    const priority = 10000 + ((hash >>> 0) % 900000);
    return priority === CATCH_ALL_PRIORITY ? priority - 1 : priority;
  });

export const resolveAppsId = (
  requested: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.length > 0) return requested;
    if (existing !== undefined && existing.length > 0) return existing;
    const env = yield* GcpEnvironment.current;
    return env.project;
  });

export const getApplication = (appsId: string) =>
  appsId.length === 0
    ? Effect.succeed(undefined)
    : appengine
        .getApps({ appsId })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const resolveLocation = (
  requested: string | undefined,
  existing: string | undefined,
  appsId: string,
) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.length > 0) {
      return lastSegment(requested);
    }
    if (existing !== undefined && existing.length > 0) {
      return lastSegment(existing);
    }
    const app = yield* getApplication(appsId);
    return app?.locationId ?? DEFAULT_LOCATION;
  });

export const catchMissing = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.catchIf(
      (error): error is E & { readonly _tag: "NotFound" } =>
        error._tag === "NotFound",
      () => Effect.succeed(undefined),
    ),
  );

export const ignoreMissing = <E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<unknown, E, R>,
) =>
  effect.pipe(
    Effect.catchIf(
      (error): error is E & { readonly _tag: "NotFound" } =>
        error._tag === "NotFound",
      () => Effect.void,
    ),
  );

const emptyList = <A>() => Effect.succeed([] as A[]);

export const listAuthorizedCertificates = (appsId: string) =>
  appsId.length === 0
    ? emptyList<appengine.AuthorizedCertificate>()
    : appengine.listAppsAuthorizedCertificates
        .pages({ appsId, pageSize: 100, view: "BASIC_CERTIFICATE" })
        .pipe(
          Stream.flatMap((page) =>
            Stream.fromIterable(page.certificates ?? []),
          ),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.catchTag("NotFound", () =>
            emptyList<appengine.AuthorizedCertificate>(),
          ),
        );

export const listApplicationsAuthorizedCertificates = (
  projectsId: string,
  locationsId: string,
  applicationsId: string,
) =>
  projectsId.length === 0 || applicationsId.length === 0
    ? emptyList<appengine.AuthorizedCertificate>()
    : appengine.listProjectsLocationsApplicationsAuthorizedCertificates
        .pages({
          projectsId,
          locationsId,
          applicationsId,
          pageSize: 100,
          view: "BASIC_CERTIFICATE",
        })
        .pipe(
          Stream.flatMap((page) =>
            Stream.fromIterable(page.certificates ?? []),
          ),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.catchTag("NotFound", () =>
            emptyList<appengine.AuthorizedCertificate>(),
          ),
        );

export const listDomainMappings = (appsId: string) =>
  appsId.length === 0
    ? emptyList<appengine.DomainMapping>()
    : appengine.listAppsDomainMappings.pages({ appsId, pageSize: 100 }).pipe(
        Stream.flatMap((page) =>
          Stream.fromIterable(page.domainMappings ?? []),
        ),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
        Effect.catchTag("NotFound", () => emptyList<appengine.DomainMapping>()),
      );

export const listApplicationsDomainMappings = (
  projectsId: string,
  locationsId: string,
  applicationsId: string,
) =>
  projectsId.length === 0 || applicationsId.length === 0
    ? emptyList<appengine.DomainMapping>()
    : appengine.listProjectsLocationsApplicationsDomainMappings
        .pages({
          projectsId,
          locationsId,
          applicationsId,
          pageSize: 100,
        })
        .pipe(
          Stream.flatMap((page) =>
            Stream.fromIterable(page.domainMappings ?? []),
          ),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.catchTag("NotFound", () =>
            emptyList<appengine.DomainMapping>(),
          ),
        );

export const listFirewallRules = (appsId: string) =>
  appsId.length === 0
    ? emptyList<appengine.FirewallRule>()
    : appengine.listAppsFirewallIngressRules
        .pages({ appsId, pageSize: 100 })
        .pipe(
          Stream.flatMap((page) =>
            Stream.fromIterable(page.ingressRules ?? []),
          ),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.catchTag("NotFound", () =>
            emptyList<appengine.FirewallRule>(),
          ),
        );

export const listServices = (appsId: string) =>
  appsId.length === 0
    ? emptyList<appengine.Service>()
    : appengine.listAppsServices.pages({ appsId, pageSize: 100 }).pipe(
        Stream.flatMap((page) => Stream.fromIterable(page.services ?? [])),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
        Effect.catchTag("NotFound", () => emptyList<appengine.Service>()),
      );

export const listVersions = (appsId: string, servicesId: string) =>
  appsId.length === 0 || servicesId.length === 0
    ? emptyList<appengine.Version>()
    : appengine.listAppsServicesVersions
        .pages({
          appsId,
          servicesId,
          pageSize: 100,
          view: "FULL",
        })
        .pipe(
          Stream.flatMap((page) => Stream.fromIterable(page.versions ?? [])),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.catchTag("NotFound", () => emptyList<appengine.Version>()),
        );

export const findOwnedCertificate = (
  id: string,
  certificates: readonly appengine.AuthorizedCertificate[],
) =>
  Effect.gen(function* () {
    for (const certificate of certificates) {
      if (yield* ownedByAlchemy(id, certificate.displayName)) {
        return certificate;
      }
    }
    return undefined;
  });

export const findOwnedFirewallRule = (
  id: string,
  rules: readonly appengine.FirewallRule[],
) =>
  Effect.gen(function* () {
    for (const rule of rules) {
      if (yield* ownedByAlchemy(id, rule.description)) {
        return rule;
      }
    }
    return undefined;
  });

export const envVariablesOf = (
  env: appengine.StringMap | undefined,
): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (key === OWNERSHIP_ENV) continue;
    if (value !== undefined) result[key] = value;
  }
  return result;
};

export const stampEnvVariables = (
  labels: Record<string, string>,
  env: Record<string, string | undefined> | undefined,
): Record<string, string | undefined> => ({
  ...(env ?? {}),
  [OWNERSHIP_ENV]: fitMarker(labels, 200),
});

export const versionOwnershipText = (version: appengine.Version) =>
  version.envVariables?.[OWNERSHIP_ENV];

export const domainIsOwned = (
  domain: string | undefined,
  ownedCertificateIds: ReadonlySet<string>,
  mapping: appengine.DomainMapping,
) => {
  if (hasOwnershipMarker(domain)) return true;
  const id = (mapping.id ?? domain ?? "").toLowerCase();
  if (id.startsWith("alchemy-") || id.includes(".alchemy-")) return true;
  const certificateId = mapping.sslSettings?.certificateId;
  return certificateId !== undefined && ownedCertificateIds.has(certificateId);
};

export const ownedCertificateIds = (
  certificates: readonly appengine.AuthorizedCertificate[],
) =>
  new Set(
    certificates
      .filter((certificate) => hasOwnershipMarker(certificate.displayName))
      .map((certificate) => certificate.id)
      .filter((id): id is string => id !== undefined && id.length > 0),
  );

export const parseCertificateName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const appsAt = parts.indexOf("apps");
  const projectsAt = parts.indexOf("projects");
  const locationsAt = parts.indexOf("locations");
  const applicationsAt = parts.indexOf("applications");
  const certsAt = parts.lastIndexOf("authorizedCertificates");
  const certificateId =
    certsAt >= 0 && parts[certsAt + 1]
      ? parts[certsAt + 1]!
      : lastSegment(name);
  const appsId =
    appsAt >= 0 && parts[appsAt + 1]
      ? parts[appsAt + 1]
      : applicationsAt >= 0
        ? parts[applicationsAt + 1]
        : undefined;
  return {
    appsId,
    project: projectsAt >= 0 ? parts[projectsAt + 1] : appsId,
    location: locationsAt >= 0 ? parts[locationsAt + 1] : undefined,
    applicationsId: applicationsAt >= 0 ? parts[applicationsAt + 1] : appsId,
    certificateId,
  };
};

export const parseDomainMappingName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const appsAt = parts.indexOf("apps");
  const projectsAt = parts.indexOf("projects");
  const locationsAt = parts.indexOf("locations");
  const applicationsAt = parts.indexOf("applications");
  const mappingsAt = parts.lastIndexOf("domainMappings");
  const domain =
    mappingsAt >= 0 ? parts.slice(mappingsAt + 1).join("/") : lastSegment(name);
  const appsId =
    appsAt >= 0 && parts[appsAt + 1]
      ? parts[appsAt + 1]
      : applicationsAt >= 0
        ? parts[applicationsAt + 1]
        : undefined;
  return {
    appsId,
    project: projectsAt >= 0 ? parts[projectsAt + 1] : appsId,
    location: locationsAt >= 0 ? parts[locationsAt + 1] : undefined,
    applicationsId: applicationsAt >= 0 ? parts[applicationsAt + 1] : appsId,
    domain,
  };
};

export const parseVersionName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const appsAt = parts.indexOf("apps");
  const servicesAt = parts.indexOf("services");
  const versionsAt = parts.indexOf("versions");
  return {
    appsId: appsAt >= 0 ? parts[appsAt + 1] : undefined,
    servicesId: servicesAt >= 0 ? parts[servicesAt + 1] : undefined,
    versionsId: versionsAt >= 0 ? parts[versionsAt + 1] : lastSegment(name),
  };
};

export const stringMapOf = (
  map: Record<string, string | undefined> | undefined,
): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(map ?? {})) {
    if (value !== undefined) result[key] = value;
  }
  return result;
};
