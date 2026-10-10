import * as networksecurity from "@distilled.cloud/gcp/networksecurity_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  normalizeLocation,
  parseResourceName,
  projectParent,
  ResourceNotResolved,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./operations.ts";

const DEFAULT_WELL_KNOWN_ROOTS =
  "NONE" satisfies networksecurity.BackendAuthenticationConfigWellKnownRootsEnum;

export type BackendAuthenticationConfigWellKnownRoots =
  | networksecurity.BackendAuthenticationConfigWellKnownRootsEnum
  | (string & {});

export type BackendAuthenticationConfigProps = {
  /**
   * Backend authentication config id. If omitted, a unique RFC1035 name
   * is generated from the stack, stage, and logical id. Immutable —
   * changing it replaces the config.
   */
  backendAuthenticationConfigId?: string;
  /**
   * Location (`global`, `us-central1`, …). Immutable — changing it
   * replaces the config.
   * @default "global"
   */
  location?: string;
  /**
   * Certificate Manager TrustConfig used to validate backend server
   * certificates. Required unless `wellKnownRoots` is `PUBLIC_ROOTS`.
   */
  trustConfig?: string;
  /**
   * Certificate Manager certificate (CLIENT_AUTH scope) presented to
   * the backend for mTLS.
   */
  clientCertificate?: string;
  /**
   * Whether public CAs are trusted in addition to `trustConfig`.
   * @default "NONE"
   */
  wellKnownRoots?: BackendAuthenticationConfigWellKnownRoots;
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type BackendAuthenticationConfig = Resource<
  "GCP.NetworkSecurity.BackendAuthenticationConfig",
  BackendAuthenticationConfigProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/backendAuthenticationConfigs/{backendAuthenticationConfig}`. */
    name: string;
    /** Config id (last path segment). */
    backendAuthenticationConfigId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** TrustConfig resource name, if set. */
    trustConfig: string | undefined;
    /** Client certificate resource name, if set. */
    clientCertificate: string | undefined;
    /** Well-known roots setting. */
    wellKnownRoots: string | undefined;
    /** User-provided description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-computed checksum. */
    etag: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Network Security BackendAuthenticationConfig — how a load balancer
 * authenticates to backends (TrustConfig, public roots, optional mTLS
 * client certificate).
 *
 * Changing `backendAuthenticationConfigId` or `location` replaces the
 * config. TrustConfig, client certificate, well-known roots,
 * description, and labels update in place.
 *
 * ### Creating a Backend Authentication Config
 * **Example:** Trust public roots
 * ```typescript
 * const config = yield* GCP.NetworkSecurity.BackendAuthenticationConfig(
 *   "BackendTls",
 *   { wellKnownRoots: "PUBLIC_ROOTS" },
 * );
 * ```
 *
 * **Example:** TrustConfig plus public roots
 * ```typescript
 * const config = yield* GCP.NetworkSecurity.BackendAuthenticationConfig(
 *   "BackendTls",
 *   {
 *     trustConfig: trust.name,
 *     wellKnownRoots: "PUBLIC_ROOTS",
 *     labels: { env: "prod" },
 *   },
 * );
 * ```
 *
 * @resource
 * @category NetworkSecurity
 */
export const BackendAuthenticationConfig =
  Resource<BackendAuthenticationConfig>(
    "GCP.NetworkSecurity.BackendAuthenticationConfig",
  );

const resourceName = (
  project: string,
  location: string,
  backendAuthenticationConfigId: string,
) =>
  `projects/${project}/locations/${location}/backendAuthenticationConfigs/${backendAuthenticationConfigId}`;

const rootsOf = (value: string | undefined) =>
  (value ?? DEFAULT_WELL_KNOWN_ROOTS).toUpperCase();

const toAttrs = (
  config: networksecurity.BackendAuthenticationConfig,
  project: string,
) => {
  const name = config.name ?? "";
  const parsed = parseResourceName(name);
  return {
    name,
    backendAuthenticationConfigId: parsed.id,
    project: parsed.parentId || project,
    location: parsed.location,
    trustConfig: config.trustConfig,
    clientCertificate: config.clientCertificate,
    wellKnownRoots: config.wellKnownRoots,
    description: config.description,
    labels: userLabels(config.labels),
    etag: config.etag,
    createTime: config.createTime,
    updateTime: config.updateTime,
  };
};

const getByName = (name: string) =>
  networksecurity
    .getProjectsLocationsBackendAuthenticationConfigs({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string) =>
  networksecurity.listProjectsLocationsBackendAuthenticationConfigs
    .pages({
      parent: projectParent(project, "-"),
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.backendAuthenticationConfigs ?? []),
      ),
      Stream.filter((config) =>
        Object.keys(config.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ),
      Stream.map((config) => toAttrs(config, project)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

export const BackendAuthenticationConfigProvider = () =>
  Provider.succeed(BackendAuthenticationConfig, {
    stables: [
      "name",
      "backendAuthenticationConfigId",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId =
        olds?.backendAuthenticationConfigId ??
        output?.backendAuthenticationConfigId;
      const nextId = news.backendAuthenticationConfigId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
      );
      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation;
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
      const backendAuthenticationConfigId = yield* toPhysicalId(
        id,
        olds?.backendAuthenticationConfigId,
        output?.backendAuthenticationConfigId,
        "backendauth",
      );
      const location = normalizeLocation(olds?.location ?? output?.location);
      const name =
        output?.name ??
        resourceName(env.project, location, backendAuthenticationConfigId);
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
        return yield* listOwned(env.project);
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const backendAuthenticationConfigId = yield* toPhysicalId(
        id,
        news.backendAuthenticationConfigId,
        output?.backendAuthenticationConfigId,
        "backendauth",
      );
      const location = normalizeLocation(news.location ?? output?.location);
      const name = resourceName(
        env.project,
        location,
        backendAuthenticationConfigId,
      );
      const wellKnownRoots = rootsOf(news.wellKnownRoots);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* networksecurity
          .createProjectsLocationsBackendAuthenticationConfigs({
            parent: projectParent(env.project, location),
            backendAuthenticationConfigId,
            body: {
              trustConfig: news.trustConfig,
              clientCertificate: news.clientCertificate,
              wellKnownRoots,
              description: news.description,
              labels: desiredLabels,
            },
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
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const trustChanged =
        (current.trustConfig ?? "") !== (news.trustConfig ?? "");
      const certChanged =
        (current.clientCertificate ?? "") !== (news.clientCertificate ?? "");
      const rootsChanged = rootsOf(current.wellKnownRoots) !== wellKnownRoots;

      if (
        labelsChanged ||
        descriptionChanged ||
        trustChanged ||
        certChanged ||
        rootsChanged
      ) {
        const updateMask = [
          labelsChanged ? "labels" : undefined,
          descriptionChanged ? "description" : undefined,
          trustChanged ? "trustConfig" : undefined,
          certChanged ? "clientCertificate" : undefined,
          rootsChanged ? "wellKnownRoots" : undefined,
        ].filter((field): field is string => field !== undefined);

        const operation =
          yield* networksecurity.patchProjectsLocationsBackendAuthenticationConfigs(
            {
              name: current.name ?? name,
              updateMask: updateMask.join(","),
              body: {
                name: current.name ?? name,
                labels: desiredLabels,
                description: news.description,
                trustConfig: news.trustConfig,
                clientCertificate: news.clientCertificate,
                wellKnownRoots,
              },
            },
          );
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* networksecurity
        .deleteProjectsLocationsBackendAuthenticationConfigs({
          name: output.name,
        })
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
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
