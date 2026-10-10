import * as apigee from "@distilled.cloud/gcp/apigee_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  attributesToRecord,
  childName,
  collectPages,
  createOwnership,
  defaultOrgName,
  desiredAttributes,
  lastSegment,
  listOrgNames,
  orgIdOf,
  orgNameOf,
  ownedBy,
  recordToAttributes,
  sameRecord,
  sameStringList,
  userAttributes,
} from "./operations.ts";

export type AppgroupsAppsKeyProps = {
  /**
   * Apigee organization id or `organizations/{org}`. Defaults to the
   * current GCP project id. Immutable — changing it replaces the key.
   */
  organization?: string;
  /**
   * Parent AppGroup name or `organizations/{org}/appgroups/{appgroup}`.
   * Immutable — changing it replaces the key.
   */
  appGroup: string;
  /**
   * Parent AppGroup app name or full resource name. Immutable — changing
   * it replaces the key.
   */
  app: string;
  /**
   * Consumer key. If omitted, a unique key is generated. Immutable —
   * changing it replaces the key.
   */
  consumerKey?: string;
  /**
   * Consumer secret. If omitted, a unique secret is generated. Immutable —
   * changing it replaces the key.
   */
  consumerSecret?: string;
  /**
   * Scopes to apply to the key.
   */
  scopes?: string[];
  /**
   * API products associated with the key. Applied after create via
   * UpdateAppGroupAppKey.
   */
  apiProducts?: string[];
  /**
   * Credential status (`approved` or `revoked`).
   * @default "approved"
   */
  status?: string;
  /**
   * Expiration time in seconds. `-1` (default) never expires. Immutable
   * after create.
   */
  expiresInSeconds?: string;
  /**
   * Custom attributes. Alchemy ownership attributes are merged in
   * automatically.
   */
  attributes?: Record<string, string>;
};

export type AppgroupsAppsKey = Resource<
  "GCP.Apigee.AppgroupsAppsKey",
  AppgroupsAppsKeyProps,
  {
    /** Full resource name `organizations/{org}/appgroups/{appgroup}/apps/{app}/keys/{key}`. */
    name: string;
    /** Consumer key. */
    consumerKey: string;
    /** Consumer secret. */
    consumerSecret: string | undefined;
    /** Parent AppGroup id. */
    appGroup: string;
    /** Parent app name. */
    app: string;
    /** Apigee organization id. */
    organization: string;
    /** Scopes. */
    scopes: string[];
    /** Associated API products. */
    apiProducts: apigee.GoogleCloudApigeeV1APIProductAssociation[];
    /** Credential status. */
    status: string | undefined;
    /** User attributes (Alchemy ownership attributes stripped). */
    attributes: Record<string, string>;
    /** Issued-at time in milliseconds since epoch. */
    issuedAt: string | undefined;
    /** Expiration time in milliseconds since epoch. */
    expiresAt: string | undefined;
  },
  never,
  Providers
>;

/**
 * A custom consumer key and secret for an Apigee AppGroup app.
 *
 * Apigee keys have no labels field, so Alchemy stamps ownership into
 * custom attributes for `list` / nuke. The consumer key is identity —
 * changing it replaces the key. Scopes, API products, status, and
 * attributes update in place.
 *
 * ### Creating an AppGroup App Key
 * **Example:** Generated key under an AppGroup app
 * ```typescript
 * const key = yield* GCP.Apigee.AppgroupsAppsKey("GroupKey", {
 *   appGroup: "partners",
 *   app: "partner-portal",
 * });
 * ```
 *
 * **Example:** Custom key and secret
 * ```typescript
 * const key = yield* GCP.Apigee.AppgroupsAppsKey("GroupKey", {
 *   appGroup: "partners",
 *   app: "partner-portal",
 *   consumerKey: "partner-key",
 *   consumerSecret: "partner-secret",
 * });
 * ```
 *
 * @resource
 * @category Apigee
 */
export const AppgroupsAppsKey = Resource<AppgroupsAppsKey>(
  "GCP.Apigee.AppgroupsAppsKey",
);

export class AppgroupsAppsKeyNotResolved extends Data.TaggedError(
  "GCP.Apigee.AppgroupsAppsKeyNotResolved",
)<{
  name: string;
}> {}

const appGroupIdOf = (appGroup: string) =>
  appGroup.includes("/appgroups/") ? lastSegment(appGroup) : appGroup;

const appNameOf = (app: string) =>
  app.includes("/apps/") ? lastSegment(app) : app;

const appParentOf = (organization: string, appGroup: string, app: string) =>
  `${childName(orgNameOf(organization), "appgroups", appGroupIdOf(appGroup))}/apps/${appNameOf(app)}`;

const resourceName = (
  organization: string,
  appGroup: string,
  app: string,
  consumerKey: string,
) => `${appParentOf(organization, appGroup, app)}/keys/${consumerKey}`;

const toKeyId = (id: string, explicit: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return explicit;
    if (existing !== undefined) return existing;
    return yield* createPhysicalName({ id, maxLength: 64, lowercase: true });
  });

const toSecret = (id: string, explicit: string | undefined) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return explicit;
    return yield* createPhysicalName({
      id: `${id}-secret`,
      maxLength: 64,
      lowercase: true,
    });
  });

const toAttrs = (
  key: apigee.GoogleCloudApigeeV1AppGroupAppKey,
  organization: string,
  appGroup: string,
  app: string,
) => {
  const consumerKey = key.consumerKey ?? "";
  return {
    name: resourceName(organization, appGroup, app, consumerKey),
    consumerKey,
    consumerSecret: key.consumerSecret,
    appGroup: appGroupIdOf(appGroup),
    app: appNameOf(app),
    organization: orgIdOf(organization),
    scopes: key.scopes ?? [],
    apiProducts: key.apiProducts ?? [],
    status: key.status,
    attributes: userAttributes(attributesToRecord(key.attributes)),
    issuedAt: key.issuedAt,
    expiresAt: key.expiresAt,
  };
};

const getByName = (name: string) =>
  apigee
    .getOrganizationsAppgroupsAppsKeys({ name })
    .pipe(
      Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
        Effect.succeed(undefined),
      ),
    );

const listAppGroups = (organization: string) =>
  collectPages(
    apigee.listOrganizationsAppgroups.pages({
      parent: organization,
      pageSize: 1000,
    }),
    (page) => page.appGroups,
  ).pipe(
    Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
      Effect.succeed([] as apigee.GoogleCloudApigeeV1AppGroup[]),
    ),
  );

const listApps = (parent: string) =>
  collectPages(
    apigee.listOrganizationsAppgroupsApps.pages({
      parent,
      pageSize: 1000,
    }),
    (page) => page.appGroupApps,
  ).pipe(
    Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
      Effect.succeed([] as apigee.GoogleCloudApigeeV1AppGroupApp[]),
    ),
  );

export const AppgroupsAppsKeyProvider = () =>
  Provider.succeed(AppgroupsAppsKey, {
    stables: [
      "name",
      "consumerKey",
      "appGroup",
      "app",
      "organization",
      "issuedAt",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousKey = olds?.consumerKey ?? output?.consumerKey;
      const previousSecret = olds?.consumerSecret ?? output?.consumerSecret;
      const previousGroup = olds?.appGroup ?? output?.appGroup;
      const previousApp = olds?.app ?? output?.app;
      const previousOrg = olds?.organization ?? output?.organization;
      const keyChanged =
        previousKey !== undefined &&
        news.consumerKey !== undefined &&
        news.consumerKey !== previousKey;
      const secretChanged =
        previousSecret !== undefined &&
        news.consumerSecret !== undefined &&
        news.consumerSecret !== previousSecret;
      const groupChanged =
        previousGroup !== undefined &&
        appGroupIdOf(news.appGroup) !== appGroupIdOf(previousGroup);
      const appChanged =
        previousApp !== undefined &&
        appNameOf(news.app) !== appNameOf(previousApp);
      const orgChanged =
        previousOrg !== undefined &&
        news.organization !== undefined &&
        orgIdOf(news.organization) !== orgIdOf(previousOrg);
      if (
        keyChanged ||
        secretChanged ||
        groupChanged ||
        appChanged ||
        orgChanged
      ) {
        return {
          action: "replace" as const,
          deleteFirst:
            keyChanged && !groupChanged && !appChanged && !orgChanged,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const organization = defaultOrgName(
        env.project,
        olds?.organization ?? output?.organization,
      );
      const appGroup = olds?.appGroup ?? output?.appGroup;
      const app = olds?.app ?? output?.app;
      if (appGroup === undefined || app === undefined) return undefined;
      const consumerKey = yield* toKeyId(
        id,
        olds?.consumerKey,
        output?.consumerKey,
      );
      const name =
        output?.name ?? resourceName(organization, appGroup, app, consumerKey);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, organization, appGroup, app);
      return (yield* ownedBy(id, attributesToRecord(existing.attributes)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const orgs = yield* listOrgNames();
        const rows: AppgroupsAppsKey["Attributes"][] = [];
        for (const organization of orgs) {
          const groups = yield* listAppGroups(organization);
          for (const group of groups) {
            const groupId = group.name ?? "";
            if (groupId.length === 0) continue;
            const parent = childName(organization, "appgroups", groupId);
            const apps = yield* listApps(parent);
            for (const app of apps) {
              const appName = app.name ?? "";
              const fetched =
                (app.credentials?.length ?? 0) > 0
                  ? app
                  : yield* apigee
                      .getOrganizationsAppgroupsApps({
                        name: `${parent}/apps/${appName}`,
                      })
                      .pipe(
                        Effect.catchTag(
                          ["NotFound", "ApigeeResourceNotFound"],
                          () => Effect.succeed(app),
                        ),
                      );
              for (const credential of fetched.credentials ?? []) {
                const labels = attributesToRecord(credential.attributes);
                if (
                  !Object.keys(labels).some((key) => key.startsWith("alchemy-"))
                ) {
                  continue;
                }
                rows.push(
                  toAttrs(
                    {
                      consumerKey: credential.consumerKey,
                      consumerSecret: credential.consumerSecret,
                      scopes: credential.scopes,
                      status: credential.status,
                      attributes: credential.attributes,
                      issuedAt: credential.issuedAt,
                      expiresAt: credential.expiresAt,
                      apiProducts: (credential.apiProducts ?? []).map(
                        (product) => ({
                          apiproduct: product.apiproduct,
                          status: product.status,
                        }),
                      ),
                    },
                    organization,
                    groupId,
                    appName,
                  ),
                );
              }
            }
          }
        }
        return rows;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const organization = defaultOrgName(env.project, news.organization);
      const appGroup = appGroupIdOf(news.appGroup);
      const app = appNameOf(news.app);
      const consumerKey = yield* toKeyId(
        id,
        news.consumerKey,
        output?.consumerKey,
      );
      const consumerSecret = yield* toSecret(
        id,
        news.consumerSecret ?? output?.consumerSecret,
      );
      const parent = appParentOf(organization, appGroup, app);
      const name = `${parent}/keys/${consumerKey}`;
      const ownership = yield* createOwnership(id);
      const attributes = desiredAttributes(news.attributes, ownership);
      const status = news.status ?? "approved";

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* apigee
          .createOrganizationsAppgroupsAppsKeys({
            parent,
            body: {
              consumerKey,
              consumerSecret,
              expiresInSeconds: news.expiresInSeconds,
              attributes: recordToAttributes(attributes),
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new AppgroupsAppsKeyNotResolved({ name });
      }

      const observedAttributes = attributesToRecord(current.attributes);
      const scopesChanged = !sameStringList(current.scopes, news.scopes);
      const productsChanged = !sameStringList(
        (current.apiProducts ?? []).map((product) => product.apiproduct ?? ""),
        news.apiProducts ?? [],
      );
      const statusChanged = (current.status ?? "") !== status;
      const attributesChanged = !sameRecord(observedAttributes, attributes);

      if (
        scopesChanged ||
        productsChanged ||
        statusChanged ||
        attributesChanged
      ) {
        current =
          yield* apigee.updateAppGroupAppKeyOrganizationsAppgroupsAppsKeys({
            name,
            body: {
              action: statusChanged ? status : undefined,
              apiProducts: news.apiProducts,
              appGroupAppKey: {
                consumerKey,
                scopes: news.scopes,
                attributes: recordToAttributes(attributes),
              },
            },
          });
      }

      return toAttrs(current, organization, appGroup, app);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* apigee
        .deleteOrganizationsAppgroupsAppsKeys({ name: output.name })
        .pipe(
          Effect.catchTag(
            ["NotFound", "ApigeeResourceNotFound"],
            () => Effect.void,
          ),
        );
    }),
  });
