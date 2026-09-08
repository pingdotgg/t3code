import type {
  BucketCreateResponse,
  BucketS3CredentialsResultItem,
  BucketUpdateResponse,
  ProjectResponseBucketsEdgesItemNode,
} from "@distilled.cloud/railway";
import * as railway from "@distilled.cloud/railway";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import {
  createRailwayName,
  matchesAlchemyPhysicalName,
  sanitizeRailwayName,
} from "./Metadata.ts";
import {
  ownedProjects,
  projectEnvironmentIds,
  type Project,
} from "./Project.ts";
import type { Providers } from "./Providers.ts";
import { withEnvironmentConfigLock } from "./transient.ts";

/**
 * A resource-valued prop: the resource itself, or an Effect that produces
 * it (so `yield* Project(...)` and `Project(...)` both type-check).
 */
type Ref<T> = T | Effect.Effect<T, never, Providers>;

/**
 * Environment identity a Bucket instance is deployed into. Accepts a
 * `Railway.Project` (its primary environment), a `Railway.Environment`,
 * or an `{ environmentId }` stub.
 */
export type BucketEnvironment = {
  readonly environmentId: string;
};

/** Default Railway bucket region (US West). Changing region replaces. */
export const DEFAULT_BUCKET_REGION = "sjc";

export interface BucketProps {
  /**
   * Parent Railway Project. Changing it replaces the Bucket.
   */
  project: Ref<Project>;
  /**
   * Environment to deploy the bucket instance into. Accepts a
   * `Railway.Project` (primary environment), a `Railway.Environment`, or
   * `{ environmentId }`. Defaults to the project's primary environment.
   * Changing it replaces the Bucket.
   */
  environment?: Ref<BucketEnvironment>;
  /**
   * Display name. Unique per project. If omitted, a unique name is
   * generated from the stack, stage and logical ID. Changing it updates
   * in place via `bucketUpdate`. The S3 API name is this plus a hash
   * (`s3BucketName`).
   */
  name?: string;
  /**
   * Bucket region (`sjc`, `iad`, `ams`, `sin`). Cannot be changed after
   * create.
   *
   * @default "sjc"
   */
  region?: string;
}

export type Bucket = Resource<
  "Railway.Bucket",
  BucketProps,
  {
    /** Railway bucket id. */
    bucketId: string;
    /** Display name (unique per project). */
    name: string;
    /** Parent Railway project id. */
    projectId: string;
    /** Environment the instance is deployed in. */
    environmentId: string;
    /** Railway region code (`sjc`, `iad`, `ams`, `sin`). */
    region: string | undefined;
    /** Globally unique S3 bucket name (`{name}-{hash}`). */
    s3BucketName: string | undefined;
    /** S3 API endpoint (`https://storage.railway.app`). */
    endpoint: string | undefined;
    /** S3 URL style (`virtual` or `path`). */
    urlStyle: string | undefined;
    /** S3 region reported by credentials (often `auto`). */
    s3Region: string | undefined;
    /**
     * S3 access key id from `bucketS3Credentials`. Never logged.
     */
    accessKeyId: Redacted.Redacted<string> | undefined;
    /**
     * S3 secret access key from `bucketS3Credentials`. Never logged.
     */
    secretAccessKey: Redacted.Redacted<string> | undefined;
    /** RFC3339 creation timestamp. */
    createdAt: string;
    /** RFC3339 update timestamp. */
    updatedAt: string;
  },
  never,
  Providers
>;

const resolveBucketProps = (
  props: BucketProps | Effect.Effect<BucketProps, never, Providers>,
): Effect.Effect<BucketProps, never, Providers> =>
  Effect.gen(function* () {
    const resolved = Effect.isEffect(props) ? yield* props : props;
    if (globalThis.__ALCHEMY_RUNTIME__) return resolved;
    const project = Effect.isEffect(resolved.project)
      ? yield* resolved.project as Effect.Effect<Project, never, Providers>
      : resolved.project;
    const environment =
      resolved.environment === undefined
        ? undefined
        : Effect.isEffect(resolved.environment)
          ? yield* resolved.environment as Effect.Effect<
              BucketEnvironment,
              never,
              Providers
            >
          : resolved.environment;
    return { ...resolved, project, environment };
  });

const BucketResource = Resource<Bucket>("Railway.Bucket");

/**
 * A Railway.Bucket is S3-compatible object storage in a Project. Each
 * environment gets its own isolated instance and credentials. Bind
 * {@link PutObject} / {@link GetObject} (and the other S3 object ops) in
 * Service init — Alchemy injects the endpoint and credentials.
 *
 * Railway has no labels. Ownership is stamped into the display name via
 * `createPhysicalName`. `name` updates in place. Changing `project`,
 * `environment`, or `region` replaces the Bucket.
 *
 * @see https://docs.railway.com/storage-buckets
 *
 * ### Create a Bucket
 * Pass a Project. Alchemy generates a unique name and deploys to the
 * project's primary environment in `sjc`.
 *
 * **Example:** Generated name
 * ```typescript
 * const site = yield* Railway.Project("Site");
 * const data = yield* Railway.Bucket("Data", { project: site });
 * ```
 *
 * :::caution[Changing `project` replaces the Bucket]
 * The Bucket is created in the new Project. The old Bucket is deleted.
 * :::
 *
 * ### A stable name
 * Pass `name` when you need a stable display name. The S3 API name is
 * this plus a short hash (`s3BucketName`).
 *
 * **Example:** Explicit name
 * ```typescript
 * const data = yield* Railway.Bucket("Data", {
 *   project: site,
 *   name: "uploads",
 * });
 * ```
 *
 * ### Region
 * Omit `region` to use `sjc`. Changing it replaces the Bucket.
 *
 * **Example:** Pin a region
 * ```typescript
 * const data = yield* Railway.Bucket("Data", {
 *   project: site,
 *   region: "iad",
 * });
 * ```
 *
 * :::caution[Changing `region` replaces the Bucket]
 * Railway cannot move a bucket. A new Bucket is created, then the old
 * one is deleted.
 * :::
 *
 * ### Environment
 * Defaults to the Project's primary environment. Pass a
 * `Railway.Environment` (or `{ environmentId }`) to target another one.
 *
 * **Example:** Extra environment
 * ```typescript
 * const staging = yield* Railway.Environment("Staging", { project: site });
 * const data = yield* Railway.Bucket("StagingData", {
 *   project: site,
 *   environment: staging,
 * });
 * ```
 *
 * :::caution[Changing `environment` replaces the Bucket]
 * The Bucket instance is created in the new environment. The old
 * instance is deleted.
 * :::
 *
 * ### Put and get objects
 * Railway buckets speak the S3 API. Bind {@link PutObject} /
 * {@link GetObject} in Service init.
 *
 * **Example:** Put an object from a Service
 * ```typescript
 * import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
 *
 * export default class Api extends Railway.Service<Api>()(
 *   "Api",
 *   { project: Site, main: import.meta.url },
 *   Effect.gen(function* () {
 *     const putObject = yield* Railway.PutObject(Data);
 *     const getObject = yield* Railway.GetObject(Data);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* putObject({
 *           Key: "hello.txt",
 *           Body: "hello",
 *           ContentType: "text/plain",
 *         });
 *         const obj = yield* getObject({ Key: "hello.txt" });
 *         return HttpServerResponse.json({ ok: obj.ETag !== undefined });
 *       }),
 *     };
 *   }).pipe(Effect.provide([Railway.PutObjectHttp, Railway.GetObjectHttp])),
 * ) {}
 * ```
 *
 * ### Module-scope declarations
 * Declare the Project once. Pass it into every child. Resource-valued
 * props accept the resource or an Effect producing it.
 *
 * **Example:** Module-scope Bucket
 * ```typescript
 * // src/data.ts
 * import * as Railway from "alchemy/Railway";
 *
 * export const Site = Railway.Project("Site");
 * export const Data = Railway.Bucket("Data", { project: Site });
 * ```
 *
 * @resource
 */
export const Bucket: typeof BucketResource = Object.assign(
  (
    id: string,
    props: BucketProps | Effect.Effect<BucketProps, never, Providers>,
  ) => BucketResource(id, resolveBucketProps(props)),
  BucketResource,
);

export class BucketNotCreated extends Data.TaggedError(
  "Railway.BucketNotCreated",
)<{
  name: string;
  projectId: string;
}> {}

export class BucketProjectRequired extends Data.TaggedError(
  "Railway.BucketProjectRequired",
)<{
  message: string;
}> {}

export class BucketEnvironmentRequired extends Data.TaggedError(
  "Railway.BucketEnvironmentRequired",
)<{
  message: string;
}> {}

class BucketCredentialsPending extends Data.TaggedError(
  "Railway.BucketCredentialsPending",
)<{
  bucketId: string;
}> {}

class BucketDeployPending extends Data.TaggedError(
  "Railway.BucketDeployPending",
)<{
  bucketId: string;
}> {}

type CloudBucket =
  | ProjectResponseBucketsEdgesItemNode
  | BucketCreateResponse
  | BucketUpdateResponse;

type BucketInstanceConfig = {
  region?: string | null;
  isDeleted?: boolean | null;
  isCreated?: boolean | null;
};

type EnvironmentConfigShape = {
  buckets?: Record<string, BucketInstanceConfig | null> | null;
};

const projectIdOf = (value: unknown): string | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as { projectId?: unknown };
  return typeof rec.projectId === "string" && rec.projectId.length > 0
    ? rec.projectId
    : undefined;
};

const environmentIdOf = (value: unknown): string | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as { environmentId?: unknown };
  return typeof rec.environmentId === "string" && rec.environmentId.length > 0
    ? rec.environmentId
    : undefined;
};

const redact = (
  value: string | undefined,
): Redacted.Redacted<string> | undefined =>
  value !== undefined && value.length > 0 ? Redacted.make(value) : undefined;

const keepSecret = (
  next: Redacted.Redacted<string> | undefined,
  previous: Redacted.Redacted<string> | undefined,
): Redacted.Redacted<string> | undefined => next ?? previous;

const parseEnvironmentConfig = (value: unknown): EnvironmentConfigShape => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const buckets = (value as { buckets?: unknown }).buckets;
  if (
    buckets === null ||
    typeof buckets !== "object" ||
    Array.isArray(buckets)
  ) {
    return {};
  }
  return { buckets: buckets as Record<string, BucketInstanceConfig | null> };
};

const instanceOf = (
  config: EnvironmentConfigShape,
  bucketId: string,
): BucketInstanceConfig | undefined => {
  const row = config.buckets?.[bucketId];
  if (row === undefined || row === null) return undefined;
  return row;
};

const isDeployed = (config: EnvironmentConfigShape, bucketId: string) => {
  const row = instanceOf(config, bucketId);
  return row !== undefined && row.isDeleted !== true;
};

const toAttrs = (
  bucket: CloudBucket,
  extra: {
    environmentId: string;
    region?: string;
    credentials?: BucketS3CredentialsResultItem;
    previous?: Bucket["Attributes"];
  },
): Bucket["Attributes"] => ({
  bucketId: bucket.id,
  name: bucket.name,
  projectId: bucket.projectId,
  environmentId: extra.environmentId,
  region: extra.region ?? extra.previous?.region,
  s3BucketName: extra.credentials?.bucketName ?? extra.previous?.s3BucketName,
  endpoint: extra.credentials?.endpoint ?? extra.previous?.endpoint,
  urlStyle: extra.credentials?.urlStyle ?? extra.previous?.urlStyle,
  s3Region: extra.credentials?.region ?? extra.previous?.s3Region,
  accessKeyId: keepSecret(
    redact(extra.credentials?.accessKeyId),
    extra.previous?.accessKeyId,
  ),
  secretAccessKey: keepSecret(
    redact(extra.credentials?.secretAccessKey),
    extra.previous?.secretAccessKey,
  ),
  createdAt: bucket.createdAt,
  updatedAt: bucket.updatedAt,
});

const resolveName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (name !== undefined) return sanitizeRailwayName(name);
    if (existing !== undefined) return existing;
    return yield* createRailwayName(id);
  });

const listProjectBuckets = (projectId: string) =>
  railway.project({ id: projectId }).pipe(
    Effect.map((project) => project.buckets.edges.map((edge) => edge.node)),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
      Effect.succeed([] as ProjectResponseBucketsEdgesItemNode[]),
    ),
  );

const findInProject = (
  projectId: string,
  match: (bucket: ProjectResponseBucketsEdgesItemNode) => boolean,
) =>
  listProjectBuckets(projectId).pipe(
    Effect.map((buckets) => buckets.find(match)),
  );

const getEnvironmentConfig = (environmentId: string, projectId: string) =>
  railway.environment({ id: environmentId, projectId }).pipe(
    Effect.map((env) => parseEnvironmentConfig(env.config)),
    Effect.retry({
      while: (e) => e._tag === "RailwayNotFound" || e._tag === "NotFound",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
      Effect.succeed({} as EnvironmentConfigShape),
    ),
  );

const environmentIdsOf = (project: {
  projectId: string;
  environmentId: string;
}) =>
  railway.environments.items({ projectId: project.projectId, first: 50 }).pipe(
    Stream.filter((env) => env.deletedAt == null),
    Stream.map((env) => env.id),
    Stream.runCollect,
    Effect.map((ids) => {
      const set = new Set(Array.from(ids));
      if (project.environmentId.length > 0) {
        set.add(project.environmentId);
      }
      return Array.from(set);
    }),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
      Effect.succeed(
        project.environmentId.length > 0 ? [project.environmentId] : [],
      ),
    ),
  );

const commitBucketPatch = (input: {
  environmentId: string;
  commitMessage: string;
  patch: Record<string, unknown>;
}) =>
  withEnvironmentConfigLock(
    input.environmentId,
    railway.environmentPatchCommit({
      environmentId: input.environmentId,
      commitMessage: input.commitMessage,
      patch: input.patch,
    }),
  );

const ensureDeployed = Effect.fn(function* (input: {
  bucketId: string;
  environmentId: string;
  projectId: string;
  region: string;
  name: string;
}) {
  const config = yield* getEnvironmentConfig(
    input.environmentId,
    input.projectId,
  );
  if (isDeployed(config, input.bucketId)) {
    return instanceOf(config, input.bucketId);
  }
  yield* commitBucketPatch({
    environmentId: input.environmentId,
    commitMessage: `Alchemy: create bucket ${input.name}`,
    patch: {
      buckets: {
        [input.bucketId]: {
          region: input.region,
          isCreated: true,
        },
      },
    },
  }).pipe(
    Effect.retry({
      while: (e) => e._tag === "RailwayNotFound" || e._tag === "NotFound",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );
  const synced = yield* getEnvironmentConfig(
    input.environmentId,
    input.projectId,
  ).pipe(
    Effect.flatMap((next) => {
      if (!isDeployed(next, input.bucketId)) {
        return Effect.fail(
          new BucketDeployPending({ bucketId: input.bucketId }),
        );
      }
      return Effect.succeed(instanceOf(next, input.bucketId));
    }),
    Effect.retry({
      while: (e) => e._tag === "Railway.BucketDeployPending",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
    Effect.catchTag("Railway.BucketDeployPending", () =>
      getEnvironmentConfig(input.environmentId, input.projectId).pipe(
        Effect.map((next) => instanceOf(next, input.bucketId)),
      ),
    ),
  );
  return synced;
});

const fetchCredentials = (input: {
  bucketId: string;
  environmentId: string;
  projectId: string;
}) =>
  railway
    .bucketS3Credentials({
      bucketId: input.bucketId,
      environmentId: input.environmentId,
      projectId: input.projectId,
    })
    .pipe(
      Effect.flatMap((items) => {
        const first = items[0];
        if (first === undefined) {
          return Effect.fail(
            new BucketCredentialsPending({ bucketId: input.bucketId }),
          );
        }
        return Effect.succeed(first);
      }),
      Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
        Effect.fail(new BucketCredentialsPending({ bucketId: input.bucketId })),
      ),
      Effect.retry({
        while: (e) => e._tag === "Railway.BucketCredentialsPending",
        times: 8,
        schedule: Schedule.spaced("2 seconds"),
      }),
      Effect.catchTag("Railway.BucketCredentialsPending", () =>
        Effect.succeed(undefined),
      ),
    );

const waitUntilGone = (input: {
  bucketId: string;
  projectId: string;
  environmentId: string;
}) =>
  getEnvironmentConfig(input.environmentId, input.projectId).pipe(
    Effect.map((config) => !isDeployed(config, input.bucketId)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (gone) => gone,
      times: 8,
    }),
  );

export const BucketProvider = () =>
  Provider.succeed(Bucket, {
    stables: ["bucketId", "projectId", "environmentId", "createdAt"],
    nuke: { dependsOn: ["Railway.Project"] },

    diff: Effect.fn(function* ({ news, output }) {
      if (news === undefined || !isResolved(news)) return undefined;
      if (output === undefined) return undefined;
      const nextProject = projectIdOf(news.project);
      const projectChanged =
        nextProject !== undefined && nextProject !== output.projectId;
      const nextEnv = environmentIdOf(news.environment);
      const environmentChanged =
        nextEnv !== undefined && nextEnv !== output.environmentId;
      const desiredRegion = news.region ?? DEFAULT_BUCKET_REGION;
      const regionChanged =
        output.region !== undefined && desiredRegion !== output.region;
      if (projectChanged || environmentChanged || regionChanged) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const projectId =
        output?.projectId ??
        (olds !== undefined ? projectIdOf(olds.project) : undefined);
      const environmentId =
        output?.environmentId ??
        (olds !== undefined
          ? (environmentIdOf(olds.environment) ?? environmentIdOf(olds.project))
          : undefined);
      const name = yield* resolveName(id, olds?.name, output?.name);
      if (projectId === undefined) return undefined;

      const found =
        (output?.bucketId !== undefined && output.bucketId.length > 0
          ? yield* findInProject(
              projectId,
              (bucket) => bucket.id === output.bucketId,
            )
          : undefined) ??
        (yield* findInProject(projectId, (bucket) => bucket.name === name));
      if (found === undefined) return undefined;

      const envId = environmentId ?? output?.environmentId ?? "";
      const config =
        envId.length > 0
          ? yield* getEnvironmentConfig(envId, projectId)
          : ({} as EnvironmentConfigShape);
      if (envId.length > 0 && !isDeployed(config, found.id)) {
        return undefined;
      }
      const attrs = toAttrs(found, {
        environmentId: envId,
        region: instanceOf(config, found.id)?.region ?? output?.region,
        previous: output,
      });
      if (output !== undefined) return attrs;
      return matchesAlchemyPhysicalName(found.name) ? attrs : Unowned(attrs);
    }),

    list: Effect.fn(function* () {
      const projects = yield* ownedProjects();
      const rows = yield* Effect.forEach(projects, (project) =>
        Effect.gen(function* () {
          const envIds = yield* projectEnvironmentIds(project);
          const buckets = yield* listProjectBuckets(project.projectId);
          const nested = yield* Effect.forEach(envIds, (environmentId) =>
            getEnvironmentConfig(environmentId, project.projectId).pipe(
              Effect.map((config) =>
                buckets
                  .filter(
                    (bucket) =>
                      matchesAlchemyPhysicalName(bucket.name) &&
                      isDeployed(config, bucket.id),
                  )
                  .map((bucket) =>
                    toAttrs(bucket, {
                      environmentId,
                      region:
                        instanceOf(config, bucket.id)?.region ?? undefined,
                    }),
                  ),
              ),
            ),
          );
          return nested.flat();
        }),
      );
      const seen = new Set<string>();
      const unique: Bucket["Attributes"][] = [];
      for (const row of rows.flat()) {
        const key = `${row.bucketId}:${row.environmentId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(row);
      }
      return unique;
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const props = news ?? ({} as BucketProps);
      const projectId = projectIdOf(props.project) ?? output?.projectId;
      if (projectId === undefined) {
        return yield* new BucketProjectRequired({
          message: "Bucket requires a resolved Railway.Project",
        });
      }
      const environmentId =
        environmentIdOf(props.environment) ??
        environmentIdOf(props.project) ??
        output?.environmentId;
      if (environmentId === undefined) {
        return yield* new BucketEnvironmentRequired({
          message:
            "Bucket requires a Railway environment (pass environment or a Project with environmentId)",
        });
      }
      const name = yield* resolveName(id, props.name, output?.name);
      const region = props.region ?? output?.region ?? DEFAULT_BUCKET_REGION;

      let current =
        output?.bucketId !== undefined && output.bucketId.length > 0
          ? yield* findInProject(
              projectId,
              (bucket) => bucket.id === output.bucketId,
            )
          : undefined;
      if (current === undefined) {
        current = yield* findInProject(
          projectId,
          (bucket) => bucket.name === name,
        );
      }

      if (current === undefined) {
        const created = yield* railway
          .bucketCreate({
            input: {
              projectId,
              name,
            },
          })
          .pipe(
            Effect.retry({
              while: (e) =>
                e._tag === "RailwayNotFound" || e._tag === "NotFound",
              times: 8,
              schedule: Schedule.spaced("1 second"),
            }),
            Effect.catchTag("RailwayValidationError", () =>
              Effect.succeed(undefined),
            ),
          );
        current =
          created ??
          (yield* findInProject(projectId, (bucket) => bucket.name === name));
      }

      if (current === undefined) {
        return yield* new BucketNotCreated({ name, projectId });
      }

      if (current.name !== name) {
        current = yield* railway.bucketUpdate({
          id: current.id,
          input: { name },
        });
      }

      const deployed = yield* ensureDeployed({
        bucketId: current.id,
        environmentId,
        projectId,
        region,
        name,
      });

      const credentials = yield* fetchCredentials({
        bucketId: current.id,
        environmentId,
        projectId,
      });

      return toAttrs(current, {
        environmentId,
        region: deployed?.region ?? region,
        credentials,
        previous: output,
      });
    }),

    delete: Effect.fn(function* ({ output }) {
      const bucketId = output.bucketId;
      const environmentId = output.environmentId;
      const projectId = output.projectId;
      if (bucketId.length === 0 || environmentId.length === 0) return;
      yield* commitBucketPatch({
        environmentId,
        commitMessage: `Alchemy: delete bucket ${output.name}`,
        patch: {
          buckets: {
            [bucketId]: { isDeleted: true },
          },
        },
      }).pipe(
        Effect.catchTag(["RailwayNotFound", "NotFound"], () => Effect.void),
      );
      if (projectId.length > 0) {
        yield* waitUntilGone({ bucketId, projectId, environmentId });
      }
    }),
  });
