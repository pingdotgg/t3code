import * as networksecurity from "@distilled.cloud/gcp/networksecurity_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  normalizeLocation,
  parentOf,
  parseResourceName,
  resourceName,
  toId,
} from "./names.ts";
import { waitForOperation } from "./operations.ts";
import {
  createInternalLabels,
  encodeDescription,
  hasAlchemyLabels,
  hasOwnershipMarker,
  parseDescription,
  sameStringList,
} from "./ownership.ts";

const COLLECTION = "urlLists";

export type UrlListProps = {
  /**
   * UrlList id (the `{urlList}` segment of
   * `projects/{project}/locations/{location}/urlLists/{urlList}`). If
   * omitted, a unique RFC1035 name is generated from the stack, stage,
   * and logical id. Must match `^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$`.
   * Immutable — changing it replaces the list.
   */
  urlListId?: string;
  /**
   * Location (`us-central1`, `us-east1`, …). Immutable — changing it
   * replaces the list. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * FQDNs, host patterns, URLs, and URL patterns in this list.
   */
  values: string[];
  /**
   * Human-readable description. UrlList has no labels field, so Alchemy
   * ownership is stored in a `[alchemy …]` prefix and stripped from
   * attributes.
   */
  description?: string;
};

export type UrlList = Resource<
  "GCP.NetworkSecurity.UrlList",
  UrlListProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/urlLists/{urlList}`. */
    name: string;
    /** UrlList id (last path segment). */
    urlListId: string;
    /** Project id. */
    project: string;
    /** Location id (`us-central1`, …). */
    location: string;
    /** FQDNs and URLs currently configured. */
    values: string[];
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A reusable list of hosts, host patterns, URLs, and URL patterns used
 * by Secure Web Proxy URL filtering.
 *
 * UrlList has no labels field, so Alchemy stamps ownership into the
 * description for `list` / nuke. Changing `urlListId` or `location`
 * replaces the list. `values` and `description` update in place.
 *
 * ### Creating a UrlList
 * **Example:** Generated name
 * ```typescript
 * const blocked = yield* GCP.NetworkSecurity.UrlList("Blocked", {
 *   values: ["malware.example.com", "phishing.example.net"],
 * });
 * ```
 *
 * **Example:** Named list with a description
 * ```typescript
 * const blocked = yield* GCP.NetworkSecurity.UrlList("Blocked", {
 *   urlListId: "app-blocked-hosts",
 *   location: "us-central1",
 *   description: "denied destinations",
 *   values: ["malware.example.com"],
 * });
 * ```
 *
 * ### Updating a UrlList
 * **Example:** Add values
 * ```typescript
 * const blocked = yield* GCP.NetworkSecurity.UrlList("Blocked", {
 *   urlListId: "app-blocked-hosts",
 *   location: "us-central1",
 *   description: "denied destinations v2",
 *   values: ["malware.example.com", "c2.example.net"],
 * });
 * ```
 *
 * @resource
 * @category NetworkSecurity
 */
export const UrlList = Resource<UrlList>("GCP.NetworkSecurity.UrlList");

export class UrlListNotResolved extends Data.TaggedError(
  "GCP.NetworkSecurity.UrlListNotResolved",
)<{
  name: string;
}> {}

export class UrlListStillExists extends Data.TaggedError(
  "GCP.NetworkSecurity.UrlListStillExists",
)<{
  name: string;
}> {}

const toAttrs = (
  list: networksecurity.UrlList,
  project: string,
  region: string,
) => {
  const name = list.name ?? "";
  const parsed = parseResourceName(name, COLLECTION);
  const owned = parseDescription(list.description);
  return {
    name,
    urlListId: parsed.id,
    project: parsed.project || project,
    location: parsed.location || region,
    values: list.values ?? [],
    description: owned.description,
    createTime: list.createTime,
    updateTime: list.updateTime,
  };
};

const getByName = (name: string) =>
  networksecurity
    .getProjectsLocationsUrlLists({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((list) =>
      list
        ? Effect.succeed(list)
        : Effect.fail(new UrlListNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.NetworkSecurity.UrlListNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((list) =>
      list === undefined
        ? Effect.void
        : Effect.fail(new UrlListStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.NetworkSecurity.UrlListStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const listOwned = (project: string, region: string) =>
  networksecurity.listProjectsLocationsUrlLists
    .pages({
      parent: parentOf(project, "-"),
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.urlLists ?? [])),
      Stream.filter((list) => hasOwnershipMarker(list.description)),
      Stream.map((list) => toAttrs(list, project, region)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

export const UrlListProvider = () =>
  Provider.succeed(UrlList, {
    stables: ["name", "urlListId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousId = olds?.urlListId ?? output?.urlListId;
      const nextId = news.urlListId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      if (
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const urlListId = yield* toId(
        id,
        olds?.urlListId,
        output?.urlListId,
        "urllist",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, COLLECTION, urlListId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* listOwned(env.project, env.region);
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const urlListId = yield* toId(
        id,
        news.urlListId,
        output?.urlListId,
        "urllist",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, COLLECTION, urlListId);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);
      const desiredValues = news.values;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* networksecurity
          .createProjectsLocationsUrlLists({
            parent: parentOf(env.project, location),
            urlListId,
            body: {
              description: desiredDescription,
              values: desiredValues,
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
        current = yield* waitUntilExists(name);
      }

      if (current === undefined) {
        return yield* new UrlListNotResolved({ name });
      }

      const descriptionChanged =
        (current.description ?? "") !== desiredDescription;
      const valuesChanged = !sameStringList(current.values, desiredValues);

      if (descriptionChanged || valuesChanged) {
        const updateMask = [
          descriptionChanged ? "description" : undefined,
          valuesChanged ? "values" : undefined,
        ].filter((field): field is string => field !== undefined);
        const operation = yield* networksecurity.patchProjectsLocationsUrlLists(
          {
            name: current.name ?? name,
            updateMask: updateMask.join(","),
            body: {
              name: current.name ?? name,
              description: desiredDescription,
              values: desiredValues,
            },
          },
        );
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(current.name ?? name);
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* networksecurity
        .deleteProjectsLocationsUrlLists({ name: output.name })
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
