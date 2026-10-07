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

const COLLECTION = "ipamAdminScopes";
const DEFAULT_PLATFORM: cnr.IpamAdminScopeEnabledAddonPlatformsItemEnum =
  "COMPUTE_ENGINE";

export type IpamAdminScopeProps = {
  /**
   * IPAM admin scope id (the `{ipamAdminScope}` segment of
   * `projects/{project}/locations/{location}/ipamAdminScopes/{ipamAdminScope}`).
   * If omitted, a unique RFC1035 name is generated. Immutable —
   * changing it replaces the scope. Only one admin scope may exist per
   * organization.
   */
  ipamAdminScopeId?: string;
  /**
   * Location of the scope. Cloud Number Registry is global — `global`
   * is the only supported value. Immutable — changing it replaces the
   * scope.
   * @default "global"
   */
  location?: string;
  /**
   * Administrative scopes enabled for discovery. Preview allows a
   * single organization (`organizations/{org}`). Immutable — changing
   * it replaces the scope.
   */
  scopes: string[];
  /**
   * Platforms whose IP addresses Cloud Number Registry discovers.
   * @default ["COMPUTE_ENGINE"]
   */
  enabledAddonPlatforms?: Array<
    cnr.IpamAdminScopeEnabledAddonPlatformsItemEnum | (string & {})
  >;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type IpamAdminScope = Resource<
  "GCP.CloudNumberRegistry.IpamAdminScope",
  IpamAdminScopeProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/ipamAdminScopes/{ipamAdminScope}`. */
    name: string;
    /** IPAM admin scope id (last path segment). */
    ipamAdminScopeId: string;
    /** Project id. */
    project: string;
    /** Location id of the resource. */
    location: string;
    /** Administrative scopes. */
    scopes: string[];
    /** Enabled discovery platforms. */
    enabledAddonPlatforms: string[];
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Discovery pipeline state (`SETUP_IN_PROGRESS`, `READY_FOR_USE`, …). */
    state: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Number Registry IPAM admin scope — the organization-wide
 * boundary for IP address discovery. Only one project in an
 * organization may own the admin scope. Creating it also creates a
 * default registry book and starts discovery (up to 24 hours).
 *
 * `ipamAdminScopeId`, `location`, and `scopes` replace the resource.
 * Platforms and labels update in place.
 *
 * ### Creating an IPAM Admin Scope
 * **Example:** Organization scope
 * ```typescript
 * const scope = yield* GCP.CloudNumberRegistry.IpamAdminScope("Org", {
 *   scopes: ["organizations/1234567890"],
 *   enabledAddonPlatforms: ["COMPUTE_ENGINE"],
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating an IPAM Admin Scope
 * **Example:** Labels
 * ```typescript
 * const scope = yield* GCP.CloudNumberRegistry.IpamAdminScope("Org", {
 *   scopes: ["organizations/1234567890"],
 *   labels: { env: "prod", role: "ipam" },
 * });
 * ```
 *
 * @resource
 * @category CloudNumberRegistry
 */
export const IpamAdminScope = Resource<IpamAdminScope>(
  "GCP.CloudNumberRegistry.IpamAdminScope",
);

const expandScopes = (scopes: readonly string[]) =>
  scopes.map((scope) =>
    scope.includes("/") ? scope : `organizations/${scope}`,
  );

const toAttrs = (item: cnr.IpamAdminScope, project: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name, COLLECTION);
  return {
    name,
    ipamAdminScopeId: parsed.id,
    project: parsed.project || project,
    location: parsed.location || DEFAULT_LOCATION,
    scopes: item.scopes ?? [],
    enabledAddonPlatforms: (item.enabledAddonPlatforms ?? []).map((value) =>
      String(value),
    ),
    labels: userLabels(item.labels),
    state: item.state,
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : cnr
        .getProjectsLocationsIpamAdminScopes({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string) =>
  listAtLocation(project, (parent) =>
    listLabeledPages(
      cnr.listProjectsLocationsIpamAdminScopes.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.ipamAdminScopes,
      (item) => item.labels,
    ),
  );

export const IpamAdminScopeProvider = () =>
  Provider.succeed(IpamAdminScope, {
    stables: [
      "name",
      "ipamAdminScopeId",
      "project",
      "location",
      "scopes",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousScopes = olds?.scopes ?? output?.scopes;
      const nextScopes = expandScopes(news.scopes);
      return replaceOnIdentity({
        previousId: olds?.ipamAdminScopeId ?? output?.ipamAdminScopeId,
        nextId:
          news.ipamAdminScopeId ??
          olds?.ipamAdminScopeId ??
          output?.ipamAdminScopeId,
        previousLocation: normalizeLocation(olds?.location ?? output?.location),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
        ),
        extra:
          previousScopes !== undefined &&
          !sameStringList(previousScopes, nextScopes),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const ipamAdminScopeId = yield* toPhysicalId(
        id,
        olds?.ipamAdminScopeId,
        output?.ipamAdminScopeId,
        "scope",
      );
      const location = normalizeLocation(olds?.location ?? output?.location);
      const name =
        output?.name ??
        resourceName(env.project, location, COLLECTION, ipamAdminScopeId);
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
      const ipamAdminScopeId = yield* toPhysicalId(
        id,
        news.ipamAdminScopeId,
        output?.ipamAdminScopeId,
        "scope",
      );
      const location = normalizeLocation(news.location ?? output?.location);
      const name = resourceName(
        env.project,
        location,
        COLLECTION,
        ipamAdminScopeId,
      );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const scopes = expandScopes(news.scopes);
      const enabledAddonPlatforms = news.enabledAddonPlatforms ?? [
        DEFAULT_PLATFORM,
      ];

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* cnr
          .createProjectsLocationsIpamAdminScopes({
            parent: parentOf(env.project, location),
            ipamAdminScopeId,
            body: {
              scopes,
              enabledAddonPlatforms,
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
      const mask = fieldMask([
        (upsert.length > 0 || removed.length > 0) && "labels",
        news.enabledAddonPlatforms !== undefined &&
          !sameStringList(
            current.enabledAddonPlatforms,
            enabledAddonPlatforms.map((value) => String(value)),
          ) &&
          "enabledAddonPlatforms",
      ]);

      if (mask.length > 0) {
        const operation = yield* cnr.patchProjectsLocationsIpamAdminScopes({
          name: current.name ?? name,
          updateMask: mask,
          body: {
            name: current.name ?? name,
            labels: desiredLabels,
            enabledAddonPlatforms,
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
      const disable = yield* cnr
        .disableProjectsLocationsIpamAdminScopes({
          name: output.name,
          body: {},
        })
        .pipe(
          Effect.catchTag(["NotFound", "BadRequest", "Conflict"], () =>
            Effect.succeed(undefined),
          ),
        );
      if (disable !== undefined) {
        yield* waitForDeleteOperation(disable);
      }

      const operation = yield* cnr
        .deleteProjectsLocationsIpamAdminScopes({
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
