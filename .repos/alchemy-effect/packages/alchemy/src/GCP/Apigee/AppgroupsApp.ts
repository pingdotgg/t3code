import * as apigee from "@distilled.cloud/gcp/apigee_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  fromAttributes,
  toAttributes,
  userAttributeList,
  type Attribute,
} from "./ownership.ts";
import {
  lastSegment,
  orgParent,
  resolveOrgId,
  sameJson,
  sortedStrings,
  toPhysicalId,
} from "./operations.ts";

const MAX_NAME_LENGTH = 255;

export type AppgroupsAppProps = {
  /**
   * Apigee organization id. Defaults to the GCP project id. Immutable.
   */
  organizationId?: string;
  /**
   * Parent AppGroup id or `organizations/{org}/appgroups/{appgroup}`.
   * Immutable.
   */
  appgroup: string;
  /**
   * App id. If omitted, a unique name is generated. Immutable.
   */
  appId?: string;
  /**
   * API products associated with the app. An API key is generated for
   * each product on create.
   */
  apiProducts?: string[];
  /**
   * App status: `approved` or `revoked`.
   * @default "approved"
   */
  status?: string;
  /**
   * OAuth callback URL.
   */
  callbackUrl?: string;
  /**
   * Consumer key lifetime in seconds. `-1` (default) never expires.
   * Immutable after create.
   */
  keyExpiresIn?: string;
  /**
   * OAuth scopes. Must already exist on associated API products.
   */
  scopes?: string[];
  /**
   * Customer attributes. Alchemy ownership attributes are merged in
   * automatically so `list` / nuke can find the app.
   */
  attributes?: Attribute[];
};

export type AppgroupsApp = Resource<
  "GCP.Apigee.AppgroupsApp",
  AppgroupsAppProps,
  {
    /** Full resource name `organizations/{org}/appgroups/{group}/apps/{app}`. */
    name: string;
    /** App id. */
    appId: string;
    /** Parent AppGroup id. */
    appgroupId: string;
    /** Organization id. */
    organizationId: string;
    /** Project id. */
    project: string;
    /** Associated API products. */
    apiProducts: string[];
    /** App status. */
    status: string | undefined;
    /** OAuth callback URL. */
    callbackUrl: string | undefined;
    /** Consumer key lifetime in seconds. */
    keyExpiresIn: string | undefined;
    /** OAuth scopes. */
    scopes: string[];
    /** User attributes (Alchemy ownership attributes stripped). */
    attributes: Attribute[];
    /** Internal app id. */
    internalAppId: string | undefined;
    /** Credentials issued for the app. */
    credentials: apigee.GoogleCloudApigeeV1Credential[];
    /** Creation time in milliseconds since epoch. */
    createdAt: string | undefined;
    /** Last modification time in milliseconds since epoch. */
    lastModifiedAt: string | undefined;
  },
  never,
  Providers
>;

/**
 * An app belonging to an Apigee AppGroup, with auto-generated API keys
 * for the associated API products.
 *
 * Apps have no labels field. Alchemy stamps ownership into attributes
 * so `list` / nuke can find them. The app name is immutable.
 *
 * ### Creating an App
 * **Example:** App bound to a product
 * ```typescript
 * const app = yield* GCP.Apigee.AppgroupsApp("Mobile", {
 *   appgroup: group.appgroupId,
 *   apiProducts: [product.apiproductId],
 *   callbackUrl: "https://example.com/oauth",
 * });
 * ```
 *
 * @resource
 * @category Apigee
 */
export const AppgroupsApp = Resource<AppgroupsApp>("GCP.Apigee.AppgroupsApp");

export class AppgroupsAppNotResolved extends Data.TaggedError(
  "GCP.Apigee.AppgroupsAppNotResolved",
)<{
  name: string;
}> {}

const groupParent = (organizationId: string, appgroup: string) =>
  `${orgParent(organizationId)}/appgroups/${lastSegment(appgroup)}`;

const resourceName = (
  organizationId: string,
  appgroup: string,
  appId: string,
) => `${groupParent(organizationId, appgroup)}/apps/${appId}`;

const toAttrs = (
  app: apigee.GoogleCloudApigeeV1AppGroupApp,
  project: string,
  organizationId: string,
  appgroupId: string,
) => {
  const appId = lastSegment(app.name ?? "");
  const attributes = userAttributeList(app.attributes);
  return {
    name: resourceName(organizationId, appgroupId, appId),
    appId,
    appgroupId: lastSegment(app.appGroup ?? appgroupId),
    organizationId,
    project,
    apiProducts: sortedStrings(app.apiProducts),
    status: app.status,
    callbackUrl: app.callbackUrl,
    keyExpiresIn: app.keyExpiresIn,
    scopes: sortedStrings(app.scopes),
    attributes,
    internalAppId: app.appId,
    credentials: [...(app.credentials ?? [])],
    createdAt: app.createdAt,
    lastModifiedAt: app.lastModifiedAt,
  };
};

const getByName = (name: string) =>
  apigee
    .getOrganizationsAppgroupsApps({ name })
    .pipe(
      Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
        Effect.succeed(undefined),
      ),
    );

export const AppgroupsAppProvider = () =>
  Provider.succeed(AppgroupsApp, {
    stables: [
      "name",
      "appId",
      "appgroupId",
      "organizationId",
      "project",
      "internalAppId",
      "createdAt",
      "keyExpiresIn",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.appId ?? output?.appId;
      const previousGroup = olds?.appgroup
        ? lastSegment(olds.appgroup)
        : output?.appgroupId;
      const previousOrg = olds?.organizationId ?? output?.organizationId;
      if (
        (previousId !== undefined &&
          news.appId !== undefined &&
          news.appId !== previousId) ||
        (previousGroup !== undefined &&
          lastSegment(news.appgroup) !== previousGroup) ||
        (previousOrg !== undefined &&
          news.organizationId !== undefined &&
          news.organizationId !== previousOrg)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const organizationId =
        olds?.organizationId ??
        output?.organizationId ??
        (yield* resolveOrgId(env.project));
      const appgroupId = lastSegment(
        olds?.appgroup ?? output?.appgroupId ?? "",
      );
      if (appgroupId.length === 0) return undefined;
      const appId = yield* toPhysicalId(
        id,
        olds?.appId,
        output?.appId,
        MAX_NAME_LENGTH,
      );
      const name =
        output?.name ?? resourceName(organizationId, appgroupId, appId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, organizationId, appgroupId);
      const { labels } = fromAttributes(existing.attributes);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const organizationId = yield* resolveOrgId(env.project);
        const groups = yield* apigee.listOrganizationsAppgroups
          .pages({
            parent: orgParent(organizationId),
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) => Stream.fromIterable(page.appGroups ?? [])),
            Stream.filter(
              (group) =>
                fromAttributes(group.attributes).labels["alchemy-id"] !==
                undefined,
            ),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
              Effect.succeed([]),
            ),
          );
        const apps = [];
        for (const group of groups) {
          const appgroupId = lastSegment(group.name ?? "");
          if (appgroupId.length === 0) continue;
          const page = yield* apigee.listOrganizationsAppgroupsApps
            .pages({
              parent: groupParent(organizationId, appgroupId),
              pageSize: 1000,
            })
            .pipe(
              Stream.flatMap((item) =>
                Stream.fromIterable(item.appGroupApps ?? []),
              ),
              Stream.filter(
                (app) =>
                  fromAttributes(app.attributes).labels["alchemy-id"] !==
                  undefined,
              ),
              Stream.map((app) =>
                toAttrs(app, env.project, organizationId, appgroupId),
              ),
              Stream.runCollect,
              Effect.map((chunk) => Array.from(chunk)),
              Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
                Effect.succeed([]),
              ),
            );
          apps.push(...page);
        }
        return apps;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const organizationId =
        news.organizationId ??
        output?.organizationId ??
        (yield* resolveOrgId(env.project));
      const appgroupId = lastSegment(news.appgroup);
      const appId = yield* toPhysicalId(
        id,
        news.appId,
        output?.appId,
        MAX_NAME_LENGTH,
      );
      const name = resourceName(organizationId, appgroupId, appId);
      const ownership = yield* createInternalLabels(id);
      const desiredAttributes = toAttributes(ownership, news.attributes);
      const desiredStatus = news.status ?? "approved";
      const body: apigee.GoogleCloudApigeeV1AppGroupApp = {
        name: appId,
        apiProducts: news.apiProducts,
        callbackUrl: news.callbackUrl,
        keyExpiresIn: news.keyExpiresIn,
        scopes: news.scopes,
        attributes: desiredAttributes,
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* apigee
          .createOrganizationsAppgroupsApps({
            parent: groupParent(organizationId, appgroupId),
            body,
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new AppgroupsAppNotResolved({ name });
      }

      const needsUpdate =
        (current.callbackUrl ?? "") !== (news.callbackUrl ?? "") ||
        !sameJson(
          sortedStrings(current.apiProducts),
          sortedStrings(news.apiProducts),
        ) ||
        !sameJson(sortedStrings(current.scopes), sortedStrings(news.scopes)) ||
        !sameJson(current.attributes ?? [], desiredAttributes);

      if (needsUpdate) {
        current = yield* apigee.updateOrganizationsAppgroupsApps({
          name,
          body,
        });
      }

      if ((current.status ?? "approved") !== desiredStatus) {
        current = yield* apigee.updateOrganizationsAppgroupsApps({
          name,
          action: desiredStatus === "approved" ? "approve" : "revoke",
        });
      }

      return toAttrs(current, env.project, organizationId, appgroupId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* apigee
        .deleteOrganizationsAppgroupsApps({ name: output.name })
        .pipe(
          Effect.catchTag(
            ["NotFound", "ApigeeResourceNotFound"],
            () => Effect.void,
          ),
        );
    }),
  });
