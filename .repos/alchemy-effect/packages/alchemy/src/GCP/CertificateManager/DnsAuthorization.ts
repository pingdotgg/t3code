import * as certificatemanager from "@distilled.cloud/gcp/certificatemanager_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { waitForOperation } from "./operations.ts";

const DEFAULT_LOCATION = "global";
const MAX_NAME_LENGTH = 63;

export type DnsAuthorizationType = "FIXED_RECORD" | "PER_PROJECT_RECORD";

export type DnsAuthorizationProps = {
  /**
   * DnsAuthorization id (the `{dnsAuthorization}` segment of
   * `projects/{project}/locations/{location}/dnsAuthorizations/{dnsAuthorization}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Must be 1-63 characters, start with a letter, and match
   * `[a-zA-Z][a-zA-Z0-9_-]*`. Immutable — changing it replaces the
   * authorization.
   */
  dnsAuthorizationId?: string;
  /**
   * Certificate Manager location (`global`, `us-central1`, …). Immutable —
   * changing it replaces the authorization. `US-CENTRAL1` is accepted and
   * normalized to `us-central1`. `FIXED_RECORD` authorizations live in
   * `global`; regional locations default to `PER_PROJECT_RECORD`.
   * @default "global"
   */
  location?: string;
  /**
   * Domain being authorized. Covers this domain and its wildcard
   * (`example.com` also covers `*.example.com`). Immutable — changing it
   * replaces the authorization.
   */
  domain: string;
  /**
   * Authorization type. Immutable — changing it replaces the
   * authorization. Defaults to `FIXED_RECORD` in `global` and
   * `PER_PROJECT_RECORD` in regional locations.
   */
  type?: DnsAuthorizationType | (string & {});
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type DnsAuthorization = Resource<
  "GCP.CertificateManager.DnsAuthorization",
  DnsAuthorizationProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/dnsAuthorizations/{dnsAuthorization}`. */
    name: string;
    /** DnsAuthorization id (last path segment). */
    dnsAuthorizationId: string;
    /** Project id. */
    project: string;
    /** Location id (`global`, `us-central1`, …). */
    location: string;
    /** Authorized domain. */
    domain: string;
    /** `FIXED_RECORD` or `PER_PROJECT_RECORD`. */
    type: string;
    /** User-provided description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** FQDN of the CNAME record to add (`_acme-challenge.example.com`). */
    dnsResourceRecordName: string | undefined;
    /** DNS record type. Currently always `CNAME`. */
    dnsResourceRecordType: string | undefined;
    /** CNAME target to publish for domain validation. */
    dnsResourceRecordData: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Certificate Manager DNS authorization proving ownership of a domain
 * for Google-managed certificates.
 *
 * Changing `dnsAuthorizationId`, `location`, `domain`, or `type` replaces
 * the resource. Description and labels update in place.
 *
 * ### Creating a DNS Authorization
 * **Example:** Generated name
 * ```typescript
 * const authorization = yield* GCP.CertificateManager.DnsAuthorization(
 *   "WwwAuth",
 *   { domain: "www.example.com" },
 * );
 * ```
 *
 * **Example:** Named authorization with labels
 * ```typescript
 * const authorization = yield* GCP.CertificateManager.DnsAuthorization(
 *   "WwwAuth",
 *   {
 *     dnsAuthorizationId: "www-example-auth",
 *     description: "prod www",
 *     domain: "www.example.com",
 *     labels: { env: "prod" },
 *   },
 * );
 * ```
 *
 * ### Regional Per-Project Records
 * **Example:** PER_PROJECT_RECORD in us-central1
 * ```typescript
 * const authorization = yield* GCP.CertificateManager.DnsAuthorization(
 *   "WwwAuth",
 *   {
 *     location: "us-central1",
 *     type: "PER_PROJECT_RECORD",
 *     domain: "www.example.com",
 *   },
 * );
 * ```
 *
 * ### Google-Managed Certificates
 * **Example:** Authorize a domain then issue a managed certificate
 * ```typescript
 * const authorization = yield* GCP.CertificateManager.DnsAuthorization(
 *   "WwwAuth",
 *   { domain: "www.example.com" },
 * );
 * const cert = yield* GCP.CertificateManager.Certificate("FrontendTls", {
 *   type: "MANAGED",
 *   managed: {
 *     domains: ["www.example.com"],
 *     dnsAuthorizations: [authorization.name],
 *   },
 * });
 * ```
 *
 * @resource
 * @category CertificateManager
 */
export const DnsAuthorization = Resource<DnsAuthorization>(
  "GCP.CertificateManager.DnsAuthorization",
);

export class DnsAuthorizationNotResolved extends Data.TaggedError(
  "GCP.CertificateManager.DnsAuthorizationNotResolved",
)<{
  name: string;
}> {}

export class DnsAuthorizationStillExists extends Data.TaggedError(
  "GCP.CertificateManager.DnsAuthorizationStillExists",
)<{
  name: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const rfc1035 = (name: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (!/^[a-z]/.test(next)) {
    next = `d${next}`;
  }
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/, "");
  return next.length > 0 ? next : "dns-authorization";
};

const normalizeLocation = (location: string | undefined) =>
  lastSegment(location ?? DEFAULT_LOCATION).toLowerCase();

const defaultType = (location: string): DnsAuthorizationType =>
  location === DEFAULT_LOCATION ? "FIXED_RECORD" : "PER_PROJECT_RECORD";

const normalizeType = (type: string | undefined, location: string) => {
  const value = (type ?? "").toUpperCase();
  return value === "" || value === "TYPE_UNSPECIFIED"
    ? defaultType(location)
    : value;
};

const resourceName = (
  project: string,
  location: string,
  dnsAuthorizationId: string,
) =>
  `projects/${project}/locations/${location}/dnsAuthorizations/${dnsAuthorizationId}`;

const parseName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const authsAt = parts.lastIndexOf("dnsAuthorizations");
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : DEFAULT_LOCATION,
    dnsAuthorizationId:
      authsAt >= 0 && parts[authsAt + 1]
        ? parts[authsAt + 1]!
        : lastSegment(name),
  };
};

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const toId = (
  id: string,
  dnsAuthorizationId: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    if (dnsAuthorizationId !== undefined) return dnsAuthorizationId;
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH,
        lowercase: true,
      }),
    );
  });

const toAttrs = (
  auth: certificatemanager.DnsAuthorization,
  project: string,
) => {
  const name = auth.name ?? "";
  const parsed = parseName(name);
  const location = parsed.location;
  return {
    name,
    dnsAuthorizationId: parsed.dnsAuthorizationId,
    project: parsed.project || project,
    location,
    domain: auth.domain ?? "",
    type: normalizeType(auth.type, location),
    description: auth.description,
    labels: userLabels(auth.labels),
    dnsResourceRecordName: auth.dnsResourceRecord?.name,
    dnsResourceRecordType: auth.dnsResourceRecord?.type,
    dnsResourceRecordData: auth.dnsResourceRecord?.data,
    createTime: auth.createTime,
    updateTime: auth.updateTime,
  };
};

const getByName = (name: string) =>
  certificatemanager
    .getProjectsLocationsDnsAuthorizations({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((auth) =>
      auth
        ? Effect.succeed(auth)
        : Effect.fail(new DnsAuthorizationNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.CertificateManager.DnsAuthorizationNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((auth) =>
      auth === undefined
        ? Effect.void
        : Effect.fail(new DnsAuthorizationStillExists({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.CertificateManager.DnsAuthorizationStillExists",
      times: 10,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const listOwnedDnsAuthorizations = (project: string) =>
  certificatemanager.listProjectsLocationsDnsAuthorizations
    .pages({
      parent: `projects/${project}/locations/-`,
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.dnsAuthorizations ?? []),
      ),
      Stream.filter((auth) =>
        Object.keys(auth.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ),
      Stream.map((auth) => toAttrs(auth, project)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

export const DnsAuthorizationProvider = () =>
  Provider.succeed(DnsAuthorization, {
    stables: [
      "name",
      "dnsAuthorizationId",
      "project",
      "location",
      "domain",
      "type",
      "dnsResourceRecordName",
      "dnsResourceRecordType",
      "dnsResourceRecordData",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;

      const previousId = olds?.dnsAuthorizationId ?? output?.dnsAuthorizationId;
      const nextId = news.dnsAuthorizationId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
      );
      const previousDomain = olds?.domain ?? output?.domain;
      const previousType = normalizeType(
        olds?.type ?? output?.type,
        previousLocation,
      );
      const nextType = normalizeType(
        news.type ?? olds?.type ?? output?.type,
        nextLocation,
      );

      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        (previousDomain !== undefined && news.domain !== previousDomain) ||
        previousType !== nextType;

      if (!replace) return undefined;
      return {
        action: "replace" as const,
        deleteFirst:
          previousLocation === nextLocation &&
          previousId !== undefined &&
          nextId === previousId,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const dnsAuthorizationId = yield* toId(
        id,
        olds?.dnsAuthorizationId,
        output?.dnsAuthorizationId,
      );
      const location = normalizeLocation(olds?.location ?? output?.location);
      const name =
        output?.name ?? resourceName(env.project, location, dnsAuthorizationId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* listOwnedDnsAuthorizations(env.project);
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const dnsAuthorizationId = yield* toId(
        id,
        news.dnsAuthorizationId,
        output?.dnsAuthorizationId,
      );
      const location = normalizeLocation(news.location ?? output?.location);
      const name = resourceName(env.project, location, dnsAuthorizationId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(name);

      if (current === undefined) {
        const body: certificatemanager.DnsAuthorization = {
          domain: news.domain,
          description: news.description,
          labels: desiredLabels,
        };
        if (news.type !== undefined) {
          body.type = news.type;
        }
        const created = yield* certificatemanager
          .createProjectsLocationsDnsAuthorizations({
            parent: `projects/${env.project}/locations/${location}`,
            dnsAuthorizationId,
            body,
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 5,
              schedule: Schedule.spaced("2 seconds"),
            }),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(name);
      }

      if (current === undefined) {
        return yield* new DnsAuthorizationNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");

      if (labelsChanged || descriptionChanged) {
        const updateMask = [
          labelsChanged ? "labels" : undefined,
          descriptionChanged ? "description" : undefined,
        ].filter((field): field is string => field !== undefined);

        const operation =
          yield* certificatemanager.patchProjectsLocationsDnsAuthorizations({
            name,
            updateMask: updateMask.join(","),
            body: {
              name,
              labels: desiredLabels,
              description: news.description,
            },
          });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(name);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* certificatemanager
        .deleteProjectsLocationsDnsAuthorizations({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(output.name);
    }),
  });
