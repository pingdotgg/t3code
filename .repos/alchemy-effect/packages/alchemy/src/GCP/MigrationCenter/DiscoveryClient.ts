import * as mc from "@distilled.cloud/gcp/migrationcenter_v1";
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
  expandParent,
  fieldMask,
  hasAlchemyLabelMap,
  locationParent,
  normalizeLocation,
  parseName,
  replaceOnIdentity,
  ResourceNotResolved,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type DiscoveryClientState = mc.DiscoveryClientStateEnum | (string & {});

export type DiscoveryClientProps = {
  /**
   * Discovery client id (the `{discoveryClient}` segment of
   * `projects/{project}/locations/{location}/discoveryClients/{discoveryClient}`).
   * If omitted, a unique RFC1035 name is generated. Immutable — changing
   * it replaces the client.
   */
  discoveryClientId?: string;
  /**
   * Region (`us-central1`, …). Immutable — changing it replaces the
   * client. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile
   *   region, else `us-central1`)
   */
  location?: string;
  /**
   * Full name of the associated source, or the source id (combined with
   * `location`). Immutable — changing it replaces the client.
   */
  source: string;
  /**
   * Service account used by the discovery client
   * (`user@project.iam.gserviceaccount.com` or
   * `projects/{project}/serviceAccounts/{email}`).
   */
  serviceAccount: string;
  /**
   * User-friendly display name. Maximum length is 63 characters.
   */
  displayName?: string;
  /**
   * Free-text description. Maximum length is 1000 characters.
   */
  description?: string;
  /**
   * Client time-to-live (input only), e.g. `"2592000s"`.
   */
  ttl?: string;
  /**
   * Client expiration time in UTC. The backend stops accepting frames
   * after this time.
   */
  expireTime?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type DiscoveryClient = Resource<
  "GCP.MigrationCenter.DiscoveryClient",
  DiscoveryClientProps,
  {
    /** Full resource name. */
    name: string;
    /** Discovery client id (last path segment). */
    discoveryClientId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Associated source resource name. */
    source: string | undefined;
    /** Service account used by the client. */
    serviceAccount: string | undefined;
    /** User-friendly display name. */
    displayName: string | undefined;
    /** Free-text description. */
    description: string | undefined;
    /** Expiration timestamp. */
    expireTime: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-reported state. */
    state: string | undefined;
    /** Client version from the last heartbeat. */
    version: string | undefined;
    /** Signals endpoint. */
    signalsEndpoint: string | undefined;
    /** Last heartbeat timestamp. */
    heartbeatTime: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Migration Center discovery client that reports on-prem asset frames
 * for a source.
 *
 * `discoveryClientId`, `location`, and `source` are immutable. Display
 * name, description, service account, expiration, and labels update in
 * place.
 *
 * ### Creating a Discovery Client
 * **Example:** Bind a scanner to a source
 * ```typescript
 * const source = yield* GCP.MigrationCenter.Source("Scanner", {
 *   type: "SOURCE_TYPE_DISCOVERY_CLIENT",
 * });
 * const client = yield* GCP.MigrationCenter.DiscoveryClient("Agent", {
 *   source: source.name,
 *   serviceAccount: "scanner@my-project.iam.gserviceaccount.com",
 *   displayName: "on-prem-agent",
 * });
 * ```
 *
 * @resource
 * @category MigrationCenter
 */
export const DiscoveryClient = Resource<DiscoveryClient>(
  "GCP.MigrationCenter.DiscoveryClient",
);

const resourceName = (
  project: string,
  location: string,
  discoveryClientId: string,
) =>
  `${locationParent(project, location)}/discoveryClients/${discoveryClientId}`;

const sourceOf = (value: string, project: string, location: string) =>
  expandParent(value, project, location, "sources");

const toAttrs = (item: mc.DiscoveryClient, project: string, region: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "discoveryClients", region);
  return {
    name,
    discoveryClientId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    source: item.source,
    serviceAccount: item.serviceAccount,
    displayName: item.displayName,
    description: item.description,
    expireTime: item.expireTime,
    labels: userLabels(item.labels),
    state: item.state,
    version: item.version,
    signalsEndpoint: item.signalsEndpoint,
    heartbeatTime: item.heartbeatTime,
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : mc
        .getProjectsLocationsDiscoveryClients({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string, region: string) =>
  mc.listProjectsLocationsDiscoveryClients
    .pages({
      parent: `projects/${project}/locations/-`,
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.discoveryClients ?? []),
      ),
      Stream.filter((item) => hasAlchemyLabelMap(item.labels)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () =>
        mc.listProjectsLocationsDiscoveryClients
          .pages({
            parent: locationParent(project, region),
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) =>
              Stream.fromIterable(page.discoveryClients ?? []),
            ),
            Stream.filter((item) => hasAlchemyLabelMap(item.labels)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () =>
              Effect.succeed([] as mc.DiscoveryClient[]),
            ),
          ),
      ),
    );

export const DiscoveryClientProvider = () =>
  Provider.succeed(DiscoveryClient, {
    stables: ["name", "discoveryClientId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousSource = olds?.source ?? output?.source;
      const nextSource = news.source;
      const sourceChanged =
        previousSource !== undefined &&
        nextSource !== undefined &&
        previousSource !== nextSource &&
        !previousSource.endsWith(`/${nextSource}`) &&
        !nextSource.endsWith(`/${previousSource}`);
      return replaceOnIdentity({
        previousId: olds?.discoveryClientId ?? output?.discoveryClientId,
        nextId:
          news.discoveryClientId ??
          olds?.discoveryClientId ??
          output?.discoveryClientId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        extra: sourceChanged,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const discoveryClientId = yield* toPhysicalId(
        id,
        olds?.discoveryClientId,
        output?.discoveryClientId,
        "discclient",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, discoveryClientId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwned(env.project, env.region);
        return items.map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const discoveryClientId = yield* toPhysicalId(
        id,
        news.discoveryClientId,
        output?.discoveryClientId,
        "discclient",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, discoveryClientId);
      const source = sourceOf(news.source, env.project, location);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const displayName = news.displayName ?? discoveryClientId;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* mc
          .createProjectsLocationsDiscoveryClients({
            parent: locationParent(env.project, location),
            discoveryClientId,
            body: {
              source,
              serviceAccount: news.serviceAccount,
              displayName,
              description: news.description,
              ttl: news.ttl,
              expireTime: news.expireTime,
              labels: desiredLabels,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
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
      const displayNameChanged = (current.displayName ?? "") !== displayName;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const serviceAccountChanged =
        (current.serviceAccount ?? "") !== news.serviceAccount;
      const expireTimeChanged =
        (current.expireTime ?? "") !== (news.expireTime ?? "");
      const mask = fieldMask([
        labelsChanged && "labels",
        displayNameChanged && "displayName",
        descriptionChanged && "description",
        serviceAccountChanged && "serviceAccount",
        expireTimeChanged && "expireTime",
      ]);

      if (mask.length > 0) {
        const operation = yield* mc.patchProjectsLocationsDiscoveryClients({
          name: current.name ?? name,
          updateMask: mask,
          body: {
            name: current.name ?? name,
            displayName,
            description: news.description,
            serviceAccount: news.serviceAccount,
            expireTime: news.expireTime,
            labels: desiredLabels,
          },
        });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* mc
        .deleteProjectsLocationsDiscoveryClients({ name: output.name })
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
