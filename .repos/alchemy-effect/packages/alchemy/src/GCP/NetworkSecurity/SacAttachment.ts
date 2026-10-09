import * as networksecurity from "@distilled.cloud/gcp/networksecurity_v1";
import * as Data from "effect/Data";
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
  lastSegment,
  normalizeLocation,
  parentOf,
  parseResourceName,
  resourceName,
  toId,
  toResourcePath,
  userLabels,
} from "./names.ts";
import { waitForOperation } from "./operations.ts";

const COLLECTION = "sacAttachments";

export type SacAttachmentProps = {
  /**
   * Attachment id (the `{sacAttachment}` segment of
   * `projects/{project}/locations/{location}/sacAttachments/{sacAttachment}`).
   * If omitted, a unique RFC1035 name is generated from the stack, stage,
   * and logical id. Immutable — changing it replaces the attachment.
   */
  sacAttachmentId?: string;
  /**
   * Region of the attachment (e.g. `us-central1`). Immutable — changing
   * it replaces the attachment. `US-CENTRAL1` is accepted and
   * normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * SAC realm that owns the attachment, as an id or full resource name.
   * The realm must already be paired with its SSE partner's realm;
   * otherwise create fails with `SacRealmNotPaired`. Immutable — changing
   * it replaces the attachment.
   */
  sacRealm: string;
  /**
   * NCC Gateway spoke associated with the attachment, as an id or full
   * resource name. Immutable — changing it replaces the attachment.
   */
  nccGateway: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   * The SAC attachment API has no patch, so changing labels replaces
   * the attachment.
   */
  labels?: Record<string, string>;
};

export type SacAttachment = Resource<
  "GCP.NetworkSecurity.SacAttachment",
  SacAttachmentProps,
  {
    /** Full resource name. */
    name: string;
    /** Attachment id (last path segment). */
    sacAttachmentId: string;
    /** Project id. */
    project: string;
    /** Region id. */
    location: string;
    /** Owning SAC realm resource name. */
    sacRealm: string | undefined;
    /** Associated NCC Gateway spoke resource name. */
    nccGateway: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-reported lifecycle state. */
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
 * A Secure Access Connect (SAC) attachment — binds an NCC Gateway to a
 * SAC realm so SSE traffic can be processed.
 *
 * The realm must first be paired with the SSE partner's realm (Palo Alto
 * Prisma Access / Symantec) on the partner side; an unpaired realm is
 * rejected with `SacRealmNotPaired`.
 *
 * The create API has no patch; changing `sacAttachmentId`, `location`,
 * `sacRealm`, `nccGateway`, or labels replaces the attachment.
 *
 * ### Creating an Attachment
 * **Example:** Generated name
 * ```typescript
 * const attachment = yield* GCP.NetworkSecurity.SacAttachment("PrismaLink", {
 *   sacRealm: realm.name,
 *   nccGateway: gateway.name,
 * });
 * ```
 *
 * **Example:** Named attachment with labels
 * ```typescript
 * const attachment = yield* GCP.NetworkSecurity.SacAttachment("PrismaLink", {
 *   sacAttachmentId: "app-prisma-link",
 *   location: "us-central1",
 *   sacRealm: realm.name,
 *   nccGateway: gateway.name,
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @category NetworkSecurity
 */
export const SacAttachment = Resource<SacAttachment>(
  "GCP.NetworkSecurity.SacAttachment",
);

export class SacAttachmentNotResolved extends Data.TaggedError(
  "GCP.NetworkSecurity.SacAttachmentNotResolved",
)<{
  name: string;
}> {}

export class SacAttachmentStillExists extends Data.TaggedError(
  "GCP.NetworkSecurity.SacAttachmentStillExists",
)<{
  name: string;
}> {}

const toAttrs = (
  attachment: networksecurity.SACAttachment,
  project: string,
  region: string,
) => {
  const name = attachment.name ?? "";
  const parsed = parseResourceName(name, COLLECTION);
  return {
    name,
    sacAttachmentId: parsed.id,
    project: parsed.project || project,
    location: parsed.location || region,
    sacRealm: attachment.sacRealm,
    nccGateway: attachment.nccGateway,
    labels: userLabels(attachment.labels),
    state: attachment.state,
    createTime: attachment.createTime,
    updateTime: attachment.updateTime,
  };
};

const getByName = (name: string) =>
  networksecurity
    .getProjectsLocationsSacAttachments({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilReady = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (attachment): attachment is networksecurity.SACAttachment =>
        attachment !== undefined,
      () => new SacAttachmentNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.NetworkSecurity.SacAttachmentNotResolved",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((attachment) =>
      attachment === undefined
        ? Effect.void
        : Effect.fail(new SacAttachmentStillExists({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.NetworkSecurity.SacAttachmentStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const listOwned = (project: string, region: string) =>
  networksecurity.listProjectsLocationsSacAttachments
    .pages({
      parent: parentOf(project, "-"),
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.sacAttachments ?? [])),
      Stream.filter((attachment) =>
        Object.keys(attachment.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ),
      Stream.map((attachment) => toAttrs(attachment, project, region)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

export const SacAttachmentProvider = () =>
  Provider.succeed(SacAttachment, {
    stables: [
      "name",
      "sacAttachmentId",
      "project",
      "location",
      "sacRealm",
      "nccGateway",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousId = olds?.sacAttachmentId ?? output?.sacAttachmentId;
      const nextId = news.sacAttachmentId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      const previousRealm = lastSegment(
        olds?.sacRealm ?? output?.sacRealm ?? "",
      );
      const nextRealm = lastSegment(news.sacRealm);
      const previousGateway = lastSegment(
        olds?.nccGateway ?? output?.nccGateway ?? "",
      );
      const nextGateway = lastSegment(news.nccGateway);
      const previousLabels = { ...toLabels(olds?.labels) };
      const nextLabels = { ...toLabels(news.labels) };
      const { upsert, removed } = diffLabels(previousLabels, nextLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        (previousRealm.length > 0 && previousRealm !== nextRealm) ||
        (previousGateway.length > 0 && previousGateway !== nextGateway) ||
        labelsChanged;
      if (!replace) return undefined;
      return { action: "replace" as const };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const sacAttachmentId = yield* toId(
        id,
        olds?.sacAttachmentId,
        output?.sacAttachmentId,
        "saca",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, COLLECTION, sacAttachmentId);
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
        return yield* listOwned(env.project, env.region);
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const sacAttachmentId = yield* toId(
        id,
        news.sacAttachmentId,
        output?.sacAttachmentId,
        "saca",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(
        env.project,
        location,
        COLLECTION,
        sacAttachmentId,
      );
      const sacRealm = toResourcePath(news.sacRealm);
      const nccGateway = toResourcePath(news.nccGateway);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* networksecurity
          .createProjectsLocationsSacAttachments({
            parent: parentOf(env.project, location),
            sacAttachmentId,
            body: {
              sacRealm,
              nccGateway,
              labels: desiredLabels,
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
        current = yield* waitUntilReady(name);
      }

      if (current === undefined) {
        return yield* new SacAttachmentNotResolved({ name });
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* networksecurity
        .deleteProjectsLocationsSacAttachments({ name: output.name })
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
