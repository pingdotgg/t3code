import * as kms from "@distilled.cloud/gcp/cloudkms_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { deterministicKmsId } from "./internal.ts";

export type KeyRingProps = {
  /**
   * Key ring id (the `{keyRing}` segment of
   * `projects/{project}/locations/{location}/keyRings/{keyRing}`).
   * If omitted, a deterministic name `{stack}-{id}-{stage}` is derived
   * (no random suffix), so a redeploy after destroy reuses the same ring
   * instead of leaking a new one. Must match `[a-zA-Z0-9_-]{1,63}`.
   * Immutable — changing it replaces the key ring.
   */
  keyRingId?: string;
  /**
   * Cloud KMS location (`us-central1`, `global`, `us`, …). Immutable —
   * changing it replaces the key ring. `US-CENTRAL1` is accepted and
   * normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
};

export type KeyRing = Resource<
  "GCP.KMS.KeyRing",
  KeyRingProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/keyRings/{keyRing}`. */
    name: string;
    /** Key ring id (last path segment). */
    keyRingId: string;
    /** Location id (`us-central1`, `global`, …). */
    location: string;
    /** Project id. */
    project: string;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud KMS KeyRing — a location-scoped container for CryptoKeys.
 *
 * Key rings have no labels and no update API. Name and location are
 * identity; Cloud KMS also has no delete API, so destroy removes the
 * resource from state only. Account-wide nuke skips this type for the
 * same reason.
 *
 * Because the ring outlives destroy, the default `keyRingId` is
 * deterministic per stack, stage, and logical id: deploying again after a
 * destroy adopts the ring left behind rather than creating another one.
 *
 * ### Creating a KeyRing
 * **Example:** Generated name
 * ```typescript
 * const keys = yield* GCP.KMS.KeyRing("Keys", {});
 * ```
 *
 * **Example:** Explicit id and location
 * ```typescript
 * const keys = yield* GCP.KMS.KeyRing("Keys", {
 *   keyRingId: "app-keys",
 *   location: "us-central1",
 * });
 * ```
 *
 * @resource
 * @category KMS
 */
export const KeyRing = Resource<KeyRing>("GCP.KMS.KeyRing");

export class KeyRingNotResolved extends Data.TaggedError(
  "GCP.KMS.KeyRingNotResolved",
)<{
  name: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeLocation = (location: string | undefined, fallback: string) =>
  lastSegment(location ?? fallback).toLowerCase();

const resourceName = (project: string, location: string, keyRingId: string) =>
  `projects/${project}/locations/${location}/keyRings/${keyRingId}`;

const parseName = (name: string, fallbackLocation: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const keyRingsAt = parts.lastIndexOf("keyRings");
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : fallbackLocation,
    keyRingId:
      keyRingsAt >= 0 && parts[keyRingsAt + 1]
        ? parts[keyRingsAt + 1]!
        : lastSegment(name),
  };
};

const toId = (id: string, keyRingId: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    return keyRingId ?? existing ?? (yield* deterministicKmsId(id));
  });

const toAttrs = (keyRing: kms.KeyRing, project: string, region: string) => {
  const name = keyRing.name ?? "";
  const parsed = parseName(name, region);
  return {
    name,
    keyRingId: parsed.keyRingId,
    location: parsed.location,
    project: parsed.project || project,
    createTime: keyRing.createTime,
  };
};

const getByName = (name: string) =>
  kms
    .getProjectsLocationsKeyRings({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listKeyRingsAt = (parent: string) =>
  Effect.gen(function* () {
    const found: kms.KeyRing[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 10; page++) {
      const response = yield* kms.listProjectsLocationsKeyRings({
        parent,
        pageSize: 1000,
        pageToken,
      });
      found.push(...(response.keyRings ?? []));
      pageToken = response.nextPageToken;
      if (pageToken === undefined || pageToken === "") break;
    }
    return found;
  }).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed([] as kms.KeyRing[])),
  );

export const KeyRingProvider = () =>
  Provider.succeed(KeyRing, {
    // Cloud KMS has no KeyRing delete API. Destroy forgets state only, so
    // nuke would loop forever on "deleted but still there".
    nuke: { skip: true },
    stables: ["name", "keyRingId", "location", "project", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousId = olds?.keyRingId ?? output?.keyRingId;
      const nextId = news.keyRingId ?? previousId;
      const idChanged =
        previousId !== undefined &&
        nextId !== undefined &&
        nextId !== previousId;

      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const locationChanged = previousLocation !== nextLocation;

      if (idChanged || locationChanged) {
        // Cannot delete the old ring; create the replacement first.
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const keyRingId = yield* toId(id, olds?.keyRingId, output?.keyRingId);
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, keyRingId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      // KeyRings have no labels, so ownership cannot be checked. A ring at
      // the deterministic `{stack}-{id}-{stage}` name can only come from an
      // earlier deploy of this same logical resource (rings are never
      // deleted, so destroy leaves it behind); adopt it. A ring is an empty
      // namespace — the keys inside carry their own ownership labels.
      return toAttrs(existing, env.project, env.region);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const found: ReturnType<typeof toAttrs>[] = [];
        let pageToken: string | undefined;
        for (let page = 0; page < 10; page++) {
          const response = yield* kms.listProjectsLocations({
            name: `projects/${env.project}`,
            pageSize: 100,
            pageToken,
          });
          const parents = (response.locations ?? [])
            .map((location) => location.name)
            .filter((name): name is string => !!name);
          const pages = yield* Effect.forEach(
            parents,
            (parent) => listKeyRingsAt(parent),
            { concurrency: 4 },
          );
          for (const keyRings of pages) {
            for (const keyRing of keyRings) {
              found.push(toAttrs(keyRing, env.project, env.region));
            }
          }
          pageToken = response.nextPageToken;
          if (pageToken === undefined || pageToken === "") break;
        }
        return found;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const keyRingId = yield* toId(id, news.keyRingId, output?.keyRingId);
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, keyRingId);

      // A ring already at this name is adopted as ours (see `read`).
      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* kms
          .createProjectsLocationsKeyRings({
            parent: `projects/${env.project}/locations/${location}`,
            keyRingId,
            body: {},
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new KeyRingNotResolved({ name });
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      // Cloud KMS has no KeyRing delete API. Forget it from state; the
      // empty ring remains in the project until Google adds deletion.
      yield* Effect.logWarning(
        `GCP Cloud KMS has no KeyRing delete API — "${output.name}" was removed from state but still exists.`,
      );
    }),
  });
