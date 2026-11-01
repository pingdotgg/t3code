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
  toPhysicalId,
} from "./operations.ts";

const MAX_NAME_LENGTH = 255;

export type AppgroupProps = {
  /**
   * Apigee organization id. Defaults to the GCP project id. Immutable.
   */
  organizationId?: string;
  /**
   * AppGroup name (`A-Z0-9._-$ %`). If omitted, a unique name is
   * generated. Immutable.
   */
  appgroupId?: string;
  /**
   * Name shown in the UI.
   */
  displayName?: string;
  /**
   * Contact email for the AppGroup.
   */
  email?: string;
  /**
   * Channel identifier of the owner maintaining this grouping.
   */
  channelId?: string;
  /**
   * Reference to the associated storefront or marketplace.
   */
  channelUri?: string;
  /**
   * `active` or `inactive`. Status is synced via the update `action`
   * query parameter.
   * @default "active"
   */
  status?: string;
  /**
   * Customer attributes. Alchemy ownership attributes are merged in
   * automatically so `list` / nuke can find the group.
   */
  attributes?: Attribute[];
};

export type Appgroup = Resource<
  "GCP.Apigee.Appgroup",
  AppgroupProps,
  {
    /** Full resource name `organizations/{org}/appgroups/{appgroup}`. */
    name: string;
    /** AppGroup id. */
    appgroupId: string;
    /** Organization id. */
    organizationId: string;
    /** Project id. */
    project: string;
    /** Display name. */
    displayName: string | undefined;
    /** Contact email. */
    email: string | undefined;
    /** Channel id. */
    channelId: string | undefined;
    /** Channel URI. */
    channelUri: string | undefined;
    /** `active` or `inactive`. */
    status: string | undefined;
    /** User attributes (Alchemy ownership attributes stripped). */
    attributes: Attribute[];
    /** Internal AppGroup id. */
    appGroupId: string | undefined;
    /** Creation time in milliseconds since epoch. */
    createdAt: string | undefined;
    /** Last modification time in milliseconds since epoch. */
    lastModifiedAt: string | undefined;
  },
  never,
  Providers
>;

/**
 * An Apigee AppGroup — a logical grouping of apps that share credentials.
 *
 * AppGroups have no labels field. Alchemy stamps ownership into
 * attributes so `list` / nuke can find them. The name is immutable.
 *
 * ### Creating an AppGroup
 * **Example:** Generated name
 * ```typescript
 * const group = yield* GCP.Apigee.Appgroup("Partners", {
 *   displayName: "Partners",
 *   email: "partners@example.com",
 * });
 * ```
 *
 * **Example:** Inactive group
 * ```typescript
 * const group = yield* GCP.Apigee.Appgroup("Partners", {
 *   appgroupId: "partners",
 *   status: "inactive",
 * });
 * ```
 *
 * @resource
 * @category Apigee
 */
export const Appgroup = Resource<Appgroup>("GCP.Apigee.Appgroup");

export class AppgroupNotResolved extends Data.TaggedError(
  "GCP.Apigee.AppgroupNotResolved",
)<{
  name: string;
}> {}

const resourceName = (organizationId: string, appgroupId: string) =>
  `${orgParent(organizationId)}/appgroups/${appgroupId}`;

const toAttrs = (
  group: apigee.GoogleCloudApigeeV1AppGroup,
  project: string,
  organizationId: string,
) => {
  const appgroupId = lastSegment(group.name ?? "");
  const attributes = userAttributeList(group.attributes);
  return {
    name: resourceName(organizationId, appgroupId),
    appgroupId,
    organizationId: group.organization ?? organizationId,
    project,
    displayName: group.displayName,
    email: group.email,
    channelId: group.channelId,
    channelUri: group.channelUri,
    status: group.status,
    attributes,
    appGroupId: group.appGroupId,
    createdAt: group.createdAt,
    lastModifiedAt: group.lastModifiedAt,
  };
};

const getByName = (name: string) =>
  apigee
    .getOrganizationsAppgroups({ name })
    .pipe(
      Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
        Effect.succeed(undefined),
      ),
    );

export const AppgroupProvider = () =>
  Provider.succeed(Appgroup, {
    stables: [
      "name",
      "appgroupId",
      "organizationId",
      "project",
      "appGroupId",
      "createdAt",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.appgroupId ?? output?.appgroupId;
      const previousOrg = olds?.organizationId ?? output?.organizationId;
      if (
        (previousId !== undefined &&
          news.appgroupId !== undefined &&
          news.appgroupId !== previousId) ||
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
      const appgroupId = yield* toPhysicalId(
        id,
        olds?.appgroupId,
        output?.appgroupId,
        MAX_NAME_LENGTH,
      );
      const name = output?.name ?? resourceName(organizationId, appgroupId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, organizationId);
      const { labels } = fromAttributes(existing.attributes);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const organizationId = yield* resolveOrgId(env.project);
        return yield* apigee.listOrganizationsAppgroups
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
            Stream.map((group) => toAttrs(group, env.project, organizationId)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
              Effect.succeed([]),
            ),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const organizationId =
        news.organizationId ??
        output?.organizationId ??
        (yield* resolveOrgId(env.project));
      const appgroupId = yield* toPhysicalId(
        id,
        news.appgroupId,
        output?.appgroupId,
        MAX_NAME_LENGTH,
      );
      const name = resourceName(organizationId, appgroupId);
      const ownership = yield* createInternalLabels(id);
      const desiredAttributes = toAttributes(ownership, news.attributes);
      const desiredStatus = news.status ?? "active";
      const body: apigee.GoogleCloudApigeeV1AppGroup = {
        name: appgroupId,
        displayName: news.displayName ?? appgroupId,
        email: news.email,
        channelId: news.channelId,
        channelUri: news.channelUri,
        attributes: desiredAttributes,
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* apigee
          .createOrganizationsAppgroups({
            parent: orgParent(organizationId),
            body,
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new AppgroupNotResolved({ name });
      }

      const needsUpdate =
        (current.displayName ?? "") !== (body.displayName ?? "") ||
        (current.email ?? "") !== (news.email ?? "") ||
        (current.channelId ?? "") !== (news.channelId ?? "") ||
        (current.channelUri ?? "") !== (news.channelUri ?? "") ||
        !sameJson(current.attributes ?? [], desiredAttributes);

      if (needsUpdate) {
        current = yield* apigee.updateOrganizationsAppgroups({
          name,
          body,
        });
      }

      if ((current.status ?? "active") !== desiredStatus) {
        current = yield* apigee.updateOrganizationsAppgroups({
          name,
          action: desiredStatus,
        });
      }

      return toAttrs(current, env.project, organizationId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* apigee
        .deleteOrganizationsAppgroups({ name: output.name })
        .pipe(
          Effect.catchTag(
            ["NotFound", "ApigeeResourceNotFound"],
            () => Effect.void,
          ),
        );
    }),
  });
