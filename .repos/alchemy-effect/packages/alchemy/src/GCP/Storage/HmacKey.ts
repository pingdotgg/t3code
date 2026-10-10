import * as storage from "@distilled.cloud/gcp/storage_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

export type HmacKeyState = "ACTIVE" | "INACTIVE";

const DEFAULT_STATE: HmacKeyState = "ACTIVE";

export type HmacKeyProps = {
  /**
   * Email of the service account this HMAC key authenticates. Immutable —
   * changing it replaces the key. The service account must belong to the
   * same project.
   */
  serviceAccountEmail: string;
  /**
   * Desired key state. Newly created keys are always `ACTIVE`; this value
   * is applied after create. An HMAC key must be `INACTIVE` before it can
   * be deleted.
   * @default "ACTIVE"
   */
  state?: HmacKeyState;
};

export type HmacKey = Resource<
  "GCP.Storage.HmacKey",
  HmacKeyProps,
  {
    /** Access id assigned by Cloud Storage; the API id for get/update/delete. */
    accessId: string;
    /**
     * Composite HMAC key id (`{projectId}/{accessId}`), when the API
     * returns one.
     */
    id: string | undefined;
    /** Project id that owns the service account. */
    projectId: string;
    /** Email of the service account this key authenticates. */
    serviceAccountEmail: string;
    /** Key state (`ACTIVE` or `INACTIVE`). */
    state: HmacKeyState;
    /** RFC3339 creation timestamp. */
    timeCreated: string | undefined;
    /** RFC3339 last-update timestamp. */
    updated: string | undefined;
    /** GCS self-link. */
    selfLink: string | undefined;
    /** HTTP etag used for concurrent updates. */
    etag: string | undefined;
    /**
     * HMAC secret. Cloud Storage returns it only at create time; later
     * reads preserve the originally stored redacted value. Never logged.
     */
    secret: Redacted.Redacted<string> | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Storage HMAC key for a service account.
 *
 * HMAC keys authenticate S3-compatible interoperable requests. Cloud
 * Storage returns the secret once at create time; Alchemy stores it
 * redacted and never re-reads it. Keys have no labels field, so `list`
 * enumerates every HMAC key in the project (excluding `DELETED`) for
 * `pnpm nuke:gcp`. A service account may have at most ten keys in
 * `ACTIVE` or `INACTIVE` state. Changing `serviceAccountEmail` replaces
 * the key. Destroy deactivates the key, then deletes it.
 *
 * ### Creating an HMAC Key
 * **Example:** Active key for a service account
 * ```typescript
 * const key = yield* GCP.Storage.HmacKey("interop", {
 *   serviceAccountEmail: "app@project.iam.gserviceaccount.com",
 * });
 * ```
 *
 * **Example:** Inactive key
 * ```typescript
 * const key = yield* GCP.Storage.HmacKey("interop", {
 *   serviceAccountEmail: "app@project.iam.gserviceaccount.com",
 *   state: "INACTIVE",
 * });
 * ```
 *
 * @resource
 * @category Storage
 */
export const HmacKey = Resource<HmacKey>("GCP.Storage.HmacKey");

export class HmacKeyNotResolved extends Data.TaggedError(
  "GCP.Storage.HmacKeyNotResolved",
)<{
  projectId: string;
  serviceAccountEmail: string;
  accessId?: string;
}> {}

export class HmacKeyStillExists extends Data.TaggedError(
  "GCP.Storage.HmacKeyStillExists",
)<{
  projectId: string;
  accessId: string;
}> {}

const sameEmail = (left: string, right: string) =>
  left.trim().toLowerCase() === right.trim().toLowerCase();

const normalizeState = (state: string | undefined): HmacKeyState =>
  state?.toUpperCase() === "INACTIVE" ? "INACTIVE" : DEFAULT_STATE;

const toSecret = (
  value: string | Redacted.Redacted<string> | undefined,
): Redacted.Redacted<string> | undefined =>
  value === undefined
    ? undefined
    : typeof value === "string"
      ? Redacted.make(value)
      : value;

const toAttrs = (
  metadata: storage.HmacKeyMetadata,
  projectId: string,
  secret?: Redacted.Redacted<string>,
): HmacKey["Attributes"] => ({
  accessId: metadata.accessId ?? "",
  id: metadata.id,
  projectId: metadata.projectId ?? projectId,
  serviceAccountEmail: metadata.serviceAccountEmail ?? "",
  state: normalizeState(metadata.state),
  timeCreated: metadata.timeCreated,
  updated: metadata.updated,
  selfLink: metadata.selfLink,
  etag: metadata.etag,
  secret,
});

const isDeleted = (metadata: storage.HmacKeyMetadata | undefined) =>
  metadata === undefined || metadata.state?.toUpperCase() === "DELETED";

const getByAccessId = (projectId: string, accessId: string) =>
  storage.getProjectsHmacKeys({ projectId, accessId }).pipe(
    Effect.map((metadata) => (isDeleted(metadata) ? undefined : metadata)),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

const waitUntilGone = (projectId: string, accessId: string) =>
  getByAccessId(projectId, accessId).pipe(
    Effect.flatMap((existing) =>
      existing === undefined
        ? Effect.void
        : Effect.fail(new HmacKeyStillExists({ projectId, accessId })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Storage.HmacKeyStillExists",
      times: 10,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const deactivateThenDelete = (projectId: string, accessId: string) =>
  Effect.gen(function* () {
    const current = yield* getByAccessId(projectId, accessId);
    if (current === undefined) return;
    if (normalizeState(current.state) === "ACTIVE") {
      yield* storage
        .updateProjectsHmacKeys({
          projectId,
          accessId,
          body: {
            accessId,
            state: "INACTIVE",
            etag: current.etag,
          },
        })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
        );
    }
    yield* storage
      .deleteProjectsHmacKeys({ projectId, accessId })
      .pipe(Effect.catchTag("NotFound", () => Effect.void));
  }).pipe(
    Effect.retry({
      while: (error) =>
        error._tag === "BadRequest" || error._tag === "Conflict",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

export const HmacKeyProvider = () =>
  Provider.succeed(HmacKey, {
    stables: [
      "accessId",
      "id",
      "projectId",
      "serviceAccountEmail",
      "timeCreated",
      "selfLink",
      "secret",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previous = olds?.serviceAccountEmail ?? output?.serviceAccountEmail;
      if (
        previous !== undefined &&
        !sameEmail(previous, news.serviceAccountEmail)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output }) {
      if (output?.accessId === undefined || output.accessId.length === 0) {
        return undefined;
      }
      const env = yield* GcpEnvironment.current;
      const projectId = output.projectId || env.project;
      const existing = yield* getByAccessId(projectId, output.accessId);
      if (existing === undefined) return undefined;
      return toAttrs(existing, projectId, output.secret);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* storage.listProjectsHmacKeys
          .items({
            projectId: env.project,
            maxResults: 250,
          })
          .pipe(
            Stream.filter(
              (item) =>
                !!item.accessId && item.state?.toUpperCase() !== "DELETED",
            ),
            Stream.map((item) => toAttrs(item, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          );
      }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const env = yield* GcpEnvironment.current;
      const projectId = env.project;
      const serviceAccountEmail = news.serviceAccountEmail;
      const desiredState = news.state ?? DEFAULT_STATE;

      let current =
        output?.accessId !== undefined && output.accessId.length > 0
          ? yield* getByAccessId(projectId, output.accessId)
          : undefined;
      let secret = output?.secret;

      if (current === undefined) {
        const created = yield* storage.createProjectsHmacKeys({
          projectId,
          serviceAccountEmail,
        });
        current = created.metadata;
        secret = toSecret(created.secret) ?? secret;
      }

      if (current === undefined || !current.accessId) {
        return yield* new HmacKeyNotResolved({
          projectId,
          serviceAccountEmail,
          accessId: output?.accessId,
        });
      }

      if (normalizeState(current.state) !== desiredState) {
        const accessId = current.accessId;
        current = yield* Effect.gen(function* () {
          const latest = yield* getByAccessId(projectId, accessId);
          if (latest === undefined) {
            return yield* new HmacKeyNotResolved({
              projectId,
              serviceAccountEmail,
              accessId,
            });
          }
          if (normalizeState(latest.state) === desiredState) {
            return latest;
          }
          return yield* storage.updateProjectsHmacKeys({
            projectId,
            accessId,
            body: {
              accessId,
              state: desiredState,
              etag: latest.etag,
            },
          });
        }).pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("1 second"),
          }),
        );
      }

      return toAttrs(current, projectId, secret);
    }),

    delete: Effect.fn(function* ({ output }) {
      const projectId = output.projectId;
      const accessId = output.accessId;
      if (!projectId || !accessId) return;
      yield* deactivateThenDelete(projectId, accessId);
      yield* waitUntilGone(projectId, accessId);
    }),
  });
