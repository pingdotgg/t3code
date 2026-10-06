import * as cnr from "@distilled.cloud/gcp/cloudnumberregistry_v1alpha";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
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
  DEFAULT_LOCATION,
  ResourceNotResolved,
  fieldMask,
  listAtLocation,
  listLabeledPages,
  normalizeLocation,
  parentOf,
  parseName,
  replaceOnIdentity,
  resourceName,
  sameStringList,
  toPhysicalId,
  userLabels,
  waitForDeleteOperation,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

const COLLECTION = "registryBooks";

export type RegistryBookAggregatedData = {
  discoveredRangesCount: number | undefined;
  uniqueScopesCount: number | undefined;
  customRealmsCount: number | undefined;
  customRangesCount: number | undefined;
  discoveredRealmsCount: number | undefined;
};

export type RegistryBookProps = {
  /**
   * Registry book id (the `{registryBook}` segment of
   * `projects/{project}/locations/{location}/registryBooks/{registryBook}`).
   * If omitted, a unique RFC1035 name is generated. Immutable — changing
   * it replaces the book.
   */
  registryBookId?: string;
  /**
   * Location of the registry book. Cloud Number Registry is global —
   * `global` is the only supported value. Immutable — changing it
   * replaces the book.
   * @default "global"
   */
  location?: string;
  /**
   * Scopes claimed by this book. In Preview only project scopes are
   * supported (`projects/{project}`). Each scope can be claimed once.
   * Omit to organize only user-managed realms.
   */
  claimedScopes?: string[];
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type RegistryBook = Resource<
  "GCP.CloudNumberRegistry.RegistryBook",
  RegistryBookProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/registryBooks/{registryBook}`. */
    name: string;
    /** Registry book id (last path segment). */
    registryBookId: string;
    /** Project id. */
    project: string;
    /** Location id of the resource. */
    location: string;
    /** Scopes claimed by this book. */
    claimedScopes: string[];
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Whether this is the default registry book created with the IPAM admin scope. */
    isDefault: boolean | undefined;
    /** Aggregated counts, populated when the view is AGGREGATE. */
    aggregatedData: RegistryBookAggregatedData | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Number Registry book — a container for IP address management
 * information. Creating an IPAM admin scope also creates a default book;
 * additional books organize discovered or user-managed realms.
 *
 * `registryBookId` and `location` replace the resource. `claimedScopes`
 * and labels update in place.
 *
 * ### Creating a Registry Book
 * **Example:** Generated name
 * ```typescript
 * const book = yield* GCP.CloudNumberRegistry.RegistryBook("Inventory", {});
 * ```
 *
 * **Example:** Named book that claims a project
 * ```typescript
 * const book = yield* GCP.CloudNumberRegistry.RegistryBook("Inventory", {
 *   registryBookId: "inventory",
 *   claimedScopes: ["projects/my-project"],
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating a Registry Book
 * **Example:** Labels
 * ```typescript
 * const book = yield* GCP.CloudNumberRegistry.RegistryBook("Inventory", {
 *   registryBookId: "inventory",
 *   labels: { env: "prod", role: "ipam" },
 * });
 * ```
 *
 * @resource
 * @category CloudNumberRegistry
 */
export const RegistryBook = Resource<RegistryBook>(
  "GCP.CloudNumberRegistry.RegistryBook",
);

const expandScopes = (scopes: readonly string[] | undefined, project: string) =>
  (scopes ?? []).map((scope) =>
    scope.includes("/") ? scope : `projects/${scope || project}`,
  );

const toAttrs = (item: cnr.RegistryBook, project: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name, COLLECTION);
  return {
    name,
    registryBookId: parsed.id,
    project: parsed.project || project,
    location: parsed.location || DEFAULT_LOCATION,
    claimedScopes: item.claimedScopes ?? [],
    labels: userLabels(item.labels),
    isDefault: item.isDefault,
    aggregatedData: item.aggregatedData
      ? {
          discoveredRangesCount: item.aggregatedData.discoveredRangesCount,
          uniqueScopesCount: item.aggregatedData.uniqueScopesCount,
          customRealmsCount: item.aggregatedData.customRealmsCount,
          customRangesCount: item.aggregatedData.customRangesCount,
          discoveredRealmsCount: item.aggregatedData.discoveredRealmsCount,
        }
      : undefined,
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : cnr
        .getProjectsLocationsRegistryBooks({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string) =>
  listAtLocation(project, (parent) =>
    listLabeledPages(
      cnr.listProjectsLocationsRegistryBooks.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.registryBooks,
      (item) => item.labels,
    ),
  );

export const RegistryBookProvider = () =>
  Provider.succeed(RegistryBook, {
    stables: [
      "name",
      "registryBookId",
      "project",
      "location",
      "isDefault",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return replaceOnIdentity({
        previousId: olds?.registryBookId ?? output?.registryBookId,
        nextId:
          news.registryBookId ?? olds?.registryBookId ?? output?.registryBookId,
        previousLocation: normalizeLocation(olds?.location ?? output?.location),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
        ),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const registryBookId = yield* toPhysicalId(
        id,
        olds?.registryBookId,
        output?.registryBookId,
        "book",
      );
      const location = normalizeLocation(olds?.location ?? output?.location);
      const name =
        output?.name ??
        resourceName(env.project, location, COLLECTION, registryBookId);
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
        const items = yield* listOwned(env.project);
        return items.map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const registryBookId = yield* toPhysicalId(
        id,
        news.registryBookId,
        output?.registryBookId,
        "book",
      );
      const location = normalizeLocation(news.location ?? output?.location);
      const name = resourceName(
        env.project,
        location,
        COLLECTION,
        registryBookId,
      );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const claimedScopes = expandScopes(news.claimedScopes, env.project);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* cnr
          .createProjectsLocationsRegistryBooks({
            parent: parentOf(env.project, location),
            registryBookId,
            body: {
              labels: desiredLabels,
              claimedScopes:
                claimedScopes.length > 0 ? claimedScopes : undefined,
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
      const mask = fieldMask([
        (upsert.length > 0 || removed.length > 0) && "labels",
        news.claimedScopes !== undefined &&
          !sameStringList(current.claimedScopes, claimedScopes) &&
          "claimedScopes",
      ]);

      if (mask.length > 0) {
        const operation = yield* cnr.patchProjectsLocationsRegistryBooks({
          name: current.name ?? name,
          updateMask: mask,
          body: {
            name: current.name ?? name,
            labels: desiredLabels,
            claimedScopes,
          },
        });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* cnr
        .deleteProjectsLocationsRegistryBooks({
          name: output.name,
          force: true,
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
        yield* waitForDeleteOperation(operation);
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
