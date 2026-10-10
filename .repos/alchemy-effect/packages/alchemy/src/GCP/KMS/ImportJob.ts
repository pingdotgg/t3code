import * as kms from "@distilled.cloud/gcp/cloudkms_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

const DEFAULT_PROTECTION: kms.ImportJobProtectionLevelEnum = "SOFTWARE";
const DEFAULT_IMPORT_METHOD: kms.ImportJobImportMethodEnum =
  "RSA_OAEP_3072_SHA256_AES_256";
const MAX_NAME_LENGTH = 63;

export type ImportJobProps = {
  /**
   * Parent KeyRing. Full name
   * `projects/{project}/locations/{location}/keyRings/{keyRing}` or the
   * key ring id (combined with `location`). Immutable — changing it
   * replaces the import job.
   */
  keyRing: string;
  /**
   * Cloud KMS location (`us-central1`, `global`, `us`, …). Used when
   * `keyRing` is a bare id. Immutable — changing it replaces the import
   * job. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * Import job id (the last path segment). If omitted, a unique name is
   * generated from the stack, stage, and logical id. Must match
   * `[a-zA-Z0-9_-]{1,63}`. Immutable — changing it replaces the job.
   */
  importJobId?: string;
  /**
   * Wrapping method for incoming key material. Immutable. Cloud KMS has
   * no update API, so a later change is ignored unless `importJobId`
   * also changes.
   * @default "RSA_OAEP_3072_SHA256_AES_256"
   */
  importMethod?: kms.ImportJobImportMethodEnum;
  /**
   * Protection level of the wrapping key. Must match the CryptoKey
   * version template when importing. Immutable.
   * @default "SOFTWARE"
   */
  protectionLevel?: kms.ImportJobProtectionLevelEnum;
  /**
   * Backend for `HSM_SINGLE_TENANT` wrapping keys. Immutable.
   */
  cryptoKeyBackend?: string;
};

export type ImportJobAttrs = {
  /** Full resource name `projects/.../importJobs/{importJob}`. */
  name: string;
  /** Import job id (last path segment). */
  importJobId: string;
  /** Parent KeyRing resource name. */
  keyRing: string;
  /** Location id (`us-central1`, `global`, …). */
  location: string;
  /** Project id. */
  project: string;
  /** Wrapping method. */
  importMethod: string;
  /** Protection level of the wrapping key. */
  protectionLevel: string;
  /** Current job state (`PENDING_GENERATION`, `ACTIVE`, `EXPIRED`). */
  state: string | undefined;
  /** RFC3339 scheduled expiration (typically create + 3 days). */
  expireTime: string | undefined;
  /** RFC3339 time the job expired, if `state` is `EXPIRED`. */
  expireEventTime: string | undefined;
  /** RFC3339 time the wrapping key was generated. */
  generateTime: string | undefined;
  /** RFC3339 creation timestamp. */
  createTime: string | undefined;
  /** PEM wrapping public key. Present when `state` is `ACTIVE`. */
  publicKeyPem: string | undefined;
  /** Wrapping public key in the requested format, if any. */
  publicKeyData: string | undefined;
  /** External / single-tenant HSM backend, if any. */
  cryptoKeyBackend: string | undefined;
};

export type ImportJob = Resource<
  "GCP.KMS.ImportJob",
  ImportJobProps,
  ImportJobAttrs,
  never,
  Providers
>;

/**
 * A Cloud KMS ImportJob — a wrapping-key job used to import pre-existing
 * key material into a CryptoKeyVersion.
 *
 * Parent KeyRing, location, and id are identity (changing them replaces
 * the job). `importMethod`, `protectionLevel`, and `cryptoKeyBackend` are
 * immutable create-only fields. Cloud KMS has no ImportJob delete or
 * update API; destroy removes the resource from state only. Jobs expire
 * about 3 days after create and remain as `EXPIRED` residue until Google
 * garbage-collects them. Account-wide nuke skips this type for the same
 * reason. ImportJobs have no labels, so `list` returns every job under
 * listed KeyRings.
 *
 * ### Creating an ImportJob
 * **Example:** Generated name on an existing KeyRing
 * ```typescript
 * const ring = yield* GCP.KMS.KeyRing("Keys", {});
 * const job = yield* GCP.KMS.ImportJob("Wrap", {
 *   keyRing: ring.name,
 * });
 * ```
 *
 * **Example:** Explicit id, method, and protection level
 * ```typescript
 * const job = yield* GCP.KMS.ImportJob("Wrap", {
 *   keyRing: ring.name,
 *   importJobId: "wrap-keys",
 *   importMethod: "RSA_OAEP_4096_SHA256_AES_256",
 *   protectionLevel: "HSM",
 * });
 * ```
 *
 * @resource
 * @category KMS
 */
export const ImportJob = Resource<ImportJob>("GCP.KMS.ImportJob");

export class ImportJobNotResolved extends Data.TaggedError(
  "GCP.KMS.ImportJobNotResolved",
)<{
  name: string;
}> {}

export class ImportJobPending extends Data.TaggedError(
  "GCP.KMS.ImportJobPending",
)<{
  name: string;
  state: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeLocation = (location: string | undefined, fallback: string) =>
  lastSegment(location ?? fallback).toLowerCase();

const normalizeProtection = (
  value: string | undefined,
): kms.ImportJobProtectionLevelEnum =>
  !value || value === "PROTECTION_LEVEL_UNSPECIFIED"
    ? DEFAULT_PROTECTION
    : (value as kms.ImportJobProtectionLevelEnum);

const parseName = (name: string, fallbackLocation: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const importJobsAt = parts.lastIndexOf("importJobs");
  const keyRingsAt = parts.lastIndexOf("keyRings");
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  const keyRing =
    keyRingsAt >= 0 ? parts.slice(0, keyRingsAt + 2).join("/") : "";
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : fallbackLocation,
    keyRing,
    importJobId:
      importJobsAt >= 0 && parts[importJobsAt + 1]
        ? parts[importJobsAt + 1]!
        : lastSegment(name),
  };
};

const resolveParent = (
  project: string,
  keyRing: string,
  location: string | undefined,
  region: string,
) => {
  if (keyRing.includes("/")) {
    const parsed = parseName(
      keyRing.includes("/importJobs/") ? keyRing : `${keyRing}/importJobs/_`,
      region,
    );
    return {
      parent: parsed.keyRing,
      location: parsed.location,
      project: parsed.project || project,
    };
  }
  const loc = normalizeLocation(location, region);
  return {
    parent: `projects/${project}/locations/${loc}/keyRings/${keyRing}`,
    location: loc,
    project,
  };
};

const resourceName = (parent: string, importJobId: string) =>
  `${parent}/importJobs/${importJobId}`;

const toId = (id: string, importJobId: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    return (
      importJobId ??
      existing ??
      (yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH,
        lowercase: true,
      }))
    );
  });

const toAttrs = (
  job: kms.ImportJob,
  project: string,
  region: string,
): ImportJobAttrs => {
  const name = job.name ?? "";
  const parsed = parseName(name, region);
  return {
    name,
    importJobId: parsed.importJobId,
    keyRing: parsed.keyRing,
    location: parsed.location,
    project: parsed.project || project,
    importMethod: job.importMethod ?? DEFAULT_IMPORT_METHOD,
    protectionLevel: job.protectionLevel ?? DEFAULT_PROTECTION,
    state: job.state,
    expireTime: job.expireTime,
    expireEventTime: job.expireEventTime,
    generateTime: job.generateTime,
    createTime: job.createTime,
    publicKeyPem: job.publicKey?.pem,
    publicKeyData: job.publicKey?.data,
    cryptoKeyBackend: job.cryptoKeyBackend,
  };
};

const getByName = (name: string) =>
  kms
    .getProjectsLocationsKeyRingsImportJobs({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const paginate = <A, E, R>(
  fetch: (
    pageToken: string | undefined,
  ) => Effect.Effect<{ items: A[]; nextPageToken?: string }, E, R>,
) =>
  Effect.gen(function* () {
    const found: A[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 10; page++) {
      const response = yield* fetch(pageToken);
      found.push(...response.items);
      pageToken = response.nextPageToken;
      if (pageToken === undefined || pageToken === "") break;
    }
    return found;
  });

const listKeyRingsAt = (parent: string) =>
  paginate((pageToken) =>
    kms
      .listProjectsLocationsKeyRings({
        parent,
        pageSize: 1000,
        pageToken,
      })
      .pipe(
        Effect.map((response) => ({
          items: response.keyRings ?? [],
          nextPageToken: response.nextPageToken,
        })),
        Effect.catchTag("NotFound", () =>
          Effect.succeed({
            items: [] as kms.KeyRing[],
            nextPageToken: undefined,
          }),
        ),
      ),
  );

const listImportJobsInRing = (parent: string) =>
  paginate((pageToken) =>
    kms
      .listProjectsLocationsKeyRingsImportJobs({
        parent,
        pageSize: 1000,
        pageToken,
      })
      .pipe(
        Effect.map((response) => ({
          items: response.importJobs ?? [],
          nextPageToken: response.nextPageToken,
        })),
        Effect.catchTag("NotFound", () =>
          Effect.succeed({
            items: [] as kms.ImportJob[],
            nextPageToken: undefined,
          }),
        ),
      ),
  );

const listImportJobsAt = (locationParent: string) =>
  Effect.gen(function* () {
    const rings = yield* listKeyRingsAt(locationParent);
    const pages = yield* Effect.forEach(
      rings,
      (ring) =>
        ring.name
          ? listImportJobsInRing(ring.name)
          : Effect.succeed([] as kms.ImportJob[]),
      { concurrency: 4 },
    );
    return pages.flat();
  });

const waitReady = (
  name: string,
): Effect.Effect<
  kms.ImportJob,
  | ImportJobNotResolved
  | ImportJobPending
  | kms.GetProjectsLocationsKeyRingsImportJobsError,
  kms.GcpOpContext
> => {
  const probe: Effect.Effect<
    kms.ImportJob,
    | ImportJobNotResolved
    | ImportJobPending
    | kms.GetProjectsLocationsKeyRingsImportJobsError,
    kms.GcpOpContext
  > = getByName(name).pipe(
    Effect.flatMap(
      (
        job,
      ): Effect.Effect<
        kms.ImportJob,
        ImportJobNotResolved | ImportJobPending
      > => {
        if (job === undefined) {
          return Effect.fail(new ImportJobNotResolved({ name }));
        }
        if (job.state === "PENDING_GENERATION") {
          return Effect.fail(
            new ImportJobPending({
              name,
              state: job.state,
            }),
          );
        }
        return Effect.succeed(job);
      },
    ),
  );
  return probe.pipe(
    Effect.retry({
      while: (error) => error._tag === "GCP.KMS.ImportJobPending",
      times: 8,
      schedule: Schedule.spaced("500 millis"),
    }),
  );
};

export const ImportJobProvider = () =>
  Provider.succeed(ImportJob, {
    // Cloud KMS has no ImportJob delete API. Destroy forgets state only,
    // so nuke would loop forever on "deleted but still there".
    nuke: { skip: true },
    stables: [
      "name",
      "importJobId",
      "keyRing",
      "location",
      "project",
      "importMethod",
      "protectionLevel",
      "cryptoKeyBackend",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;

      const previousId = olds?.importJobId ?? output?.importJobId;
      const nextId = news.importJobId ?? previousId;
      const idChanged =
        previousId !== undefined &&
        nextId !== undefined &&
        nextId !== previousId;

      const previousParent =
        output?.keyRing ??
        (olds?.keyRing
          ? resolveParent("", olds.keyRing, olds.location, env.region).parent
          : undefined);
      const nextParent = resolveParent(
        output?.project ?? "",
        news.keyRing,
        news.location ?? output?.location,
        env.region,
      ).parent;
      const parentChanged =
        previousParent !== undefined && previousParent !== nextParent;

      if (!idChanged && !parentChanged) return undefined;
      // Cannot delete the old job; create the replacement first.
      return { action: "replace" as const, deleteFirst: false };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const importJobId = yield* toId(
        id,
        olds?.importJobId,
        output?.importJobId,
      );
      const name =
        output?.name ??
        (olds?.keyRing || output?.keyRing
          ? resourceName(
              resolveParent(
                env.project,
                olds?.keyRing ?? output?.keyRing ?? "",
                olds?.location ?? output?.location,
                env.region,
              ).parent,
              importJobId,
            )
          : undefined);
      if (name === undefined) return undefined;
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      // ImportJobs have no labels, so existence at the computed name is
      // ownership. Adopting an expired job is harmless.
      return toAttrs(existing, env.project, env.region);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const found: ImportJobAttrs[] = [];
        let pageToken: string | undefined;
        for (let page = 0; page < 10; page++) {
          const response = yield* kms.listProjectsLocations({
            name: `projects/${env.project}`,
            pageSize: 100,
            pageToken,
          });
          const parents = (response.locations ?? [])
            .map((location) => location.name)
            .filter((name): name is string => !!name);
          const batches = yield* Effect.forEach(
            parents,
            (parent) => listImportJobsAt(parent),
            { concurrency: 4 },
          );
          for (const jobs of batches) {
            for (const job of jobs) {
              found.push(toAttrs(job, env.project, env.region));
            }
          }
          pageToken = response.nextPageToken;
          if (pageToken === undefined || pageToken === "") break;
        }
        return found;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const importJobId = yield* toId(
        id,
        news.importJobId,
        output?.importJobId,
      );
      const parent = resolveParent(
        env.project,
        news.keyRing,
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(parent.parent, importJobId);
      const importMethod = news.importMethod ?? DEFAULT_IMPORT_METHOD;
      const protectionLevel = normalizeProtection(news.protectionLevel);

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* kms
          .createProjectsLocationsKeyRingsImportJobs({
            parent: parent.parent,
            importJobId,
            body: {
              importMethod,
              protectionLevel,
              cryptoKeyBackend: news.cryptoKeyBackend,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ImportJobNotResolved({ name });
      }

      if (current.state === "PENDING_GENERATION") {
        current = yield* waitReady(name);
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      // Cloud KMS has no ImportJob delete API. Forget it from state; the
      // job remains until it expires (~3 days) and Google GC's it.
      yield* Effect.logWarning(
        `GCP Cloud KMS has no ImportJob delete API — "${output.name}" was removed from state but still exists.`,
      );
    }),
  });
