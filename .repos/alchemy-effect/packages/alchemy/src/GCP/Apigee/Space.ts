import * as apigee from "@distilled.cloud/gcp/apigee_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createInternalLabels,
  encodeOwnership,
  hasAlchemyLabels,
  hasOwnershipMarker,
  lastSegment,
  orgIdOf,
  orgParent,
  parseOwnership,
} from "./ownership.ts";

const MAX_ID_LENGTH = 63;

export type SpaceProps = {
  /**
   * Space id (the `{space}` segment of `organizations/{org}/spaces/{space}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Must be 1-63 characters, start with a letter, and match
   * `[a-z][a-z0-9-]*`. Immutable — changing it replaces the space.
   */
  spaceId?: string;
  /**
   * Apigee organization id. Defaults to the stack GCP project. Immutable —
   * changing it replaces the space.
   */
  organization?: string;
  /**
   * Human-readable display name. Spaces have no labels field, so Alchemy
   * ownership (`alchemy-stack` / `alchemy-stage` / `alchemy-id`) is stored
   * in a `[alchemy …]` prefix for `list` / nuke.
   */
  displayName?: string;
};

export type Space = Resource<
  "GCP.Apigee.Space",
  SpaceProps,
  {
    /** Full resource name `organizations/{org}/spaces/{space}`. */
    name: string;
    /** Space id (last path segment). */
    spaceId: string;
    /** Apigee organization id. */
    organization: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An Apigee organization space used to group API proxies, shared flows,
 * and products for IAM.
 *
 * Spaces have no labels field, so Alchemy stamps ownership into
 * `displayName` for `list` / nuke. `spaceId` and `organization` are
 * identity — changing either replaces the space. `displayName` updates
 * in place.
 *
 * ### Creating a Space
 * **Example:** Generated id
 * ```typescript
 * const space = yield* GCP.Apigee.Space("Payments", {
 *   displayName: "payments team",
 * });
 * ```
 *
 * **Example:** Explicit id
 * ```typescript
 * const space = yield* GCP.Apigee.Space("Payments", {
 *   spaceId: "payments",
 *   displayName: "payments team",
 * });
 * ```
 *
 * ### Updating a Space
 * **Example:** Change the display name
 * ```typescript
 * const space = yield* GCP.Apigee.Space("Payments", {
 *   displayName: "payments and billing",
 * });
 * ```
 *
 * @resource
 * @category Apigee
 */
export const Space = Resource<Space>("GCP.Apigee.Space");

export class SpaceNotResolved extends Data.TaggedError(
  "GCP.Apigee.SpaceNotResolved",
)<{
  name: string;
}> {}

const rfc1035 = (name: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (!/^[a-z]/.test(next)) {
    next = `s${next}`;
  }
  next = next.slice(0, MAX_ID_LENGTH).replace(/-+$/, "");
  return next.length > 0 ? next : "space";
};

const resourceName = (org: string, spaceId: string) =>
  `${orgParent(org)}/spaces/${spaceId}`;

const spaceIdOf = (space: apigee.GoogleCloudApigeeV1Space) => {
  const raw = space.name ?? "";
  return raw.includes("/") ? lastSegment(raw) : raw;
};

const toId = (id: string, spaceId: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (spaceId !== undefined) return rfc1035(spaceId);
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: MAX_ID_LENGTH,
        lowercase: true,
      }),
    );
  });

const toAttrs = (space: apigee.GoogleCloudApigeeV1Space, org: string) => {
  const spaceId = spaceIdOf(space);
  const parsed = parseOwnership(space.displayName);
  const name = space.name ?? (spaceId ? resourceName(org, spaceId) : "");
  return {
    name,
    spaceId,
    organization: orgIdOf(name.startsWith("organizations/") ? name : org, org),
    displayName: parsed.text,
    createTime: space.createTime,
    updateTime: space.updateTime,
  };
};

const getByName = (name: string) =>
  apigee
    .getOrganizationsSpaces({ name })
    .pipe(
      Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
        Effect.succeed(undefined),
      ),
    );

export const SpaceProvider = () =>
  Provider.succeed(Space, {
    stables: ["name", "spaceId", "organization", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.spaceId ?? output?.spaceId;
      const idChanged =
        previousId !== undefined &&
        news.spaceId !== undefined &&
        rfc1035(news.spaceId) !== previousId;
      const previousOrg = olds?.organization ?? output?.organization;
      const orgChanged =
        previousOrg !== undefined &&
        news.organization !== undefined &&
        orgIdOf(news.organization, previousOrg) !== previousOrg;
      if (idChanged || orgChanged) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const org = orgIdOf(
        olds?.organization ?? output?.organization,
        env.project,
      );
      const spaceId = yield* toId(id, olds?.spaceId, output?.spaceId);
      const name = output?.name ?? resourceName(org, spaceId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, org);
      const { labels } = parseOwnership(existing.displayName);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const org = env.project;
        return yield* apigee.listOrganizationsSpaces
          .pages({
            parent: orgParent(org),
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) => Stream.fromIterable(page.spaces ?? [])),
            Stream.filter((space) => hasOwnershipMarker(space.displayName)),
            Stream.map((space) => toAttrs(space, org)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
              Effect.succeed([]),
            ),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const org = orgIdOf(
        news.organization ?? output?.organization,
        env.project,
      );
      const spaceId = yield* toId(id, news.spaceId, output?.spaceId);
      const name = resourceName(org, spaceId);
      const ownership = yield* createInternalLabels(id);
      const desiredDisplayName = encodeOwnership(ownership, news.displayName);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* apigee
          .createOrganizationsSpaces({
            parent: orgParent(org),
            spaceId,
            body: {
              displayName: desiredDisplayName,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new SpaceNotResolved({ name });
      }

      if ((current.displayName ?? "") !== desiredDisplayName) {
        current = yield* apigee.patchOrganizationsSpaces({
          name: current.name ?? name,
          updateMask: "display_name",
          body: {
            displayName: desiredDisplayName,
          },
        });
      }

      return toAttrs(current, org);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* apigee
        .deleteOrganizationsSpaces({ name: output.name })
        .pipe(
          Effect.catchTag(
            ["NotFound", "ApigeeResourceNotFound"],
            () => Effect.void,
          ),
        );
    }),
  });
