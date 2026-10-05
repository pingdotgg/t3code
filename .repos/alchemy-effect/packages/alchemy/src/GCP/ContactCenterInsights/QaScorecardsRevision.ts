import * as cci from "@distilled.cloud/gcp/contactcenterinsights_v1";
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
  hasOwnershipMarker,
  lastSegment,
  locationOf,
  locationParent,
  parentOf,
  toResourceId,
} from "./ownership.ts";

export type QaScorecardsRevisionProps = {
  /**
   * Parent QaScorecard resource name
   * (`projects/{project}/locations/{location}/qaScorecards/{qa_scorecard}`).
   * Immutable — changing it replaces the revision.
   */
  parent: string;
  /**
   * Revision id (the `{revision}` segment). If omitted, a unique id is
   * generated. Must match `^[a-z0-9-]{4,64}$`. Immutable — changing it
   * replaces the revision.
   */
  qaScorecardRevisionId?: string;
};

export type QaScorecardsRevision = Resource<
  "GCP.ContactCenterInsights.QaScorecardsRevision",
  QaScorecardsRevisionProps,
  {
    /** Full resource name. */
    name: string;
    /** Revision id (last path segment). */
    qaScorecardRevisionId: string;
    /** Parent scorecard resource name. */
    parent: string;
    /** Location id. */
    location: string;
    /** Project id. */
    project: string;
    /** Server-reported revision state (`EDITABLE`, `READY`, …). */
    state: string | undefined;
    /** Alternate ids such as `latest`. */
    alternateIds: string[];
    /** Scorecard snapshot captured at revision creation. */
    snapshot: cci.GoogleCloudContactcenterinsightsV1QaScorecard | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A revision of a Contact Center AI Insights QA scorecard. Changing a
 * published scorecard invalidates existing results, so updates create a
 * new revision instead of mutating the current one.
 *
 * Parent scorecard and revision id are immutable. Revisions have no
 * labels or display name — Alchemy stamps ownership into
 * `snapshot.description` on create (and list also matches revisions whose
 * parent scorecard snapshot already carries an Alchemy marker). There is
 * no update API; reconcile is observe-ensure only. A `READY` revision is
 * undeployed before delete.
 *
 * ### Creating a Scorecard Revision
 * **Example:** Editable revision under a scorecard
 * ```typescript
 * const revision = yield* GCP.ContactCenterInsights.QaScorecardsRevision(
 *   "V1",
 *   { parent: card.name },
 * );
 * ```
 *
 * @resource
 * @category ContactCenterInsights
 */
export const QaScorecardsRevision = Resource<QaScorecardsRevision>(
  "GCP.ContactCenterInsights.QaScorecardsRevision",
);

export class QaScorecardsRevisionNotResolved extends Data.TaggedError(
  "GCP.ContactCenterInsights.QaScorecardsRevisionNotResolved",
)<{
  name: string;
}> {}

const resourceName = (parent: string, qaScorecardRevisionId: string) =>
  `${parent}/revisions/${qaScorecardRevisionId}`;

const toAttrs = (
  revision: cci.GoogleCloudContactcenterinsightsV1QaScorecardRevision,
  project: string,
) => {
  const name = revision.name ?? "";
  return {
    name,
    qaScorecardRevisionId: lastSegment(name),
    parent: parentOf(name),
    location: locationOf(name),
    project,
    state: revision.state,
    alternateIds: revision.alternateIds ?? [],
    snapshot: revision.snapshot,
    createTime: revision.createTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : cci
        .getProjectsLocationsQaScorecardsRevisions({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listScorecards = (parent: string) =>
  cci.listProjectsLocationsQaScorecards.pages({ parent, pageSize: 100 }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.qaScorecards ?? [])),
    Stream.filter((card) => hasOwnershipMarker(card.description)),
    Stream.map((card) => card.name ?? ""),
    Stream.filter((name) => name.length > 0),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.catchTag("NotFound", () => Effect.succeed([] as string[])),
  );

const listRaw = (parent: string) =>
  cci.listProjectsLocationsQaScorecardsRevisions
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.qaScorecardRevisions ?? []),
      ),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const findExisting = (parent: string, qaScorecardRevisionId: string) =>
  listRaw(parent).pipe(
    Effect.map(
      (revisions) =>
        revisions.find(
          (revision) =>
            lastSegment(revision.name ?? "") === qaScorecardRevisionId,
        ) ??
        revisions.find((revision) =>
          (revision.alternateIds ?? []).includes("latest"),
        ) ??
        revisions[0],
    ),
  );

const listAtParent = (parent: string, project: string) =>
  listRaw(parent).pipe(
    Effect.map((revisions) =>
      revisions.map((revision) => toAttrs(revision, project)),
    ),
  );

export const QaScorecardsRevisionProvider = () =>
  Provider.succeed(QaScorecardsRevision, {
    stables: [
      "name",
      "qaScorecardRevisionId",
      "parent",
      "location",
      "project",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.parent ?? output?.parent;
      if (previousParent !== undefined && news.parent !== previousParent) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId =
        olds?.qaScorecardRevisionId ?? output?.qaScorecardRevisionId;
      if (
        previousId !== undefined &&
        news.qaScorecardRevisionId !== undefined &&
        news.qaScorecardRevisionId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const qaScorecardRevisionId = yield* toResourceId(
        id,
        olds?.qaScorecardRevisionId,
        output?.qaScorecardRevisionId,
      );
      const name =
        output?.name ??
        (olds?.parent !== undefined
          ? resourceName(olds.parent, qaScorecardRevisionId)
          : "");
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return hasOwnershipMarker(existing.snapshot?.description) ||
        output?.name === existing.name
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const scorecards = yield* listScorecards(
          locationParent(env.project, env.region),
        );
        const pages = yield* Effect.forEach(
          scorecards,
          (parent) => listAtParent(parent, env.project),
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const qaScorecardRevisionId = yield* toResourceId(
        id,
        news.qaScorecardRevisionId,
        output?.qaScorecardRevisionId,
      );
      const name = resourceName(news.parent, qaScorecardRevisionId);

      let current = yield* getByName(output?.name ?? name);
      if (current === undefined) {
        current = yield* findExisting(news.parent, qaScorecardRevisionId);
      }

      if (current === undefined) {
        const created = yield* cci
          .createProjectsLocationsQaScorecardsRevisions({
            parent: news.parent,
            qaScorecardRevisionId,
            body: {},
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "QaScorecardPreconditionFailed",
              times: 5,
              schedule: Schedule.exponential("250 millis"),
            }),
            Effect.catchIf(
              (error) => error._tag === "Conflict",
              () => getByName(name),
            ),
            // The scorecard's current revision is still settling; adopt it.
            Effect.catchTag("QaScorecardPreconditionFailed", () =>
              findExisting(news.parent, qaScorecardRevisionId),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new QaScorecardsRevisionNotResolved({ name });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const existing = yield* getByName(output.name);
      if (existing === undefined) return;
      if (existing.state === "READY") {
        yield* cci
          .undeployProjectsLocationsQaScorecardsRevisions({
            name: output.name,
            body: {},
          })
          .pipe(
            Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
            Effect.catchTag("BadRequest", () => Effect.succeed(undefined)),
          );
      }
      yield* cci
        .deleteProjectsLocationsQaScorecardsRevisions({
          name: output.name,
          force: true,
        })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.void),
          // The only revision goes away with its scorecard.
          Effect.catchTag("QaScorecardOnlyRevision", () => Effect.void),
        );
    }),
  });
