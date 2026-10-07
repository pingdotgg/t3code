import * as cci from "@distilled.cloud/gcp/contactcenterinsights_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeOwnership,
  hasOwnershipMarker,
  lastSegment,
  locationOf,
  locationParent,
  normalizeLocation,
  ownedByAlchemy,
  parseOwnership,
  sameText,
  toResourceId,
  updateMaskOf,
} from "./ownership.ts";

export type QaScorecardProps = {
  /**
   * Scorecard id (the `{qa_scorecard}` segment of
   * `projects/{project}/locations/{location}/qaScorecards/{qa_scorecard}`).
   * If omitted, a unique id is generated. Must match `^[a-z0-9-]{4,64}$`.
   * Immutable — changing it replaces the scorecard.
   */
  qaScorecardId?: string;
  /**
   * Location (`us-central1`, …). Immutable — changing it replaces the
   * scorecard. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * User-facing display name.
   */
  displayName?: string;
  /**
   * Human-readable description. Scorecards have no labels field, so
   * Alchemy ownership is stored in a `[alchemy …]` prefix and stripped
   * from attributes.
   */
  description?: string;
  /**
   * Whether this scorecard is the project default. Default scorecards
   * cannot be deleted.
   * @default false
   */
  isDefault?: boolean;
};

export type QaScorecard = Resource<
  "GCP.ContactCenterInsights.QaScorecard",
  QaScorecardProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/qaScorecards/{qa_scorecard}`. */
    name: string;
    /** Scorecard id (last path segment). */
    qaScorecardId: string;
    /** Location id. */
    location: string;
    /** Project id. */
    project: string;
    /** User-facing display name. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Whether this is the project default scorecard. */
    isDefault: boolean;
    /** Server-reported scorecard source. */
    source: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Contact Center AI Insights QA scorecard — a collection of questions
 * scored during analysis.
 *
 * Scorecards have no labels field — Alchemy stamps ownership into the
 * description. Location and id are immutable. Display name and
 * description update in place. Delete uses `force` so child revisions
 * and questions are removed.
 *
 * ### Creating a QA Scorecard
 * **Example:** Generated id
 * ```typescript
 * const card = yield* GCP.ContactCenterInsights.QaScorecard("Quality", {
 *   displayName: "quality",
 *   description: "call quality",
 * });
 * ```
 *
 * @resource
 * @category ContactCenterInsights
 */
export const QaScorecard = Resource<QaScorecard>(
  "GCP.ContactCenterInsights.QaScorecard",
);

export class QaScorecardNotResolved extends Data.TaggedError(
  "GCP.ContactCenterInsights.QaScorecardNotResolved",
)<{
  name: string;
}> {}

const resourceName = (
  project: string,
  location: string,
  qaScorecardId: string,
) => `${locationParent(project, location)}/qaScorecards/${qaScorecardId}`;

const toAttrs = (
  card: cci.GoogleCloudContactcenterinsightsV1QaScorecard,
  project: string,
) => {
  const name = card.name ?? "";
  const parsed = parseOwnership(card.description);
  return {
    name,
    qaScorecardId: lastSegment(name),
    location: locationOf(name),
    project,
    displayName: card.displayName,
    description: parsed.text,
    isDefault: card.isDefault === true,
    source: card.source,
    createTime: card.createTime,
    updateTime: card.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : cci
        .getProjectsLocationsQaScorecards({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (parent: string, project: string) =>
  cci.listProjectsLocationsQaScorecards.pages({ parent, pageSize: 100 }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.qaScorecards ?? [])),
    Stream.filter((card) => hasOwnershipMarker(card.description)),
    Stream.map((card) => toAttrs(card, project)),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.catchTag("NotFound", () => Effect.succeed([])),
  );

export const QaScorecardProvider = () =>
  Provider.succeed(QaScorecard, {
    stables: ["name", "qaScorecardId", "location", "project", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousLocation = olds?.location ?? output?.location;
      if (
        previousLocation !== undefined &&
        news.location !== undefined &&
        normalizeLocation(previousLocation) !== normalizeLocation(news.location)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.qaScorecardId ?? output?.qaScorecardId;
      if (
        previousId !== undefined &&
        news.qaScorecardId !== undefined &&
        news.qaScorecardId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const qaScorecardId = yield* toResourceId(
        id,
        olds?.qaScorecardId,
        output?.qaScorecardId,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location ?? env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, qaScorecardId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.description))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* listAt(
          locationParent(env.project, env.region),
          env.project,
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location ?? env.region,
      );
      const parent = locationParent(env.project, location);
      const qaScorecardId = yield* toResourceId(
        id,
        news.qaScorecardId,
        output?.qaScorecardId,
      );
      const name = resourceName(env.project, location, qaScorecardId);
      const ownership = yield* createInternalLabels(id);
      const description = encodeOwnership(ownership, news.description);
      const displayName = news.displayName ?? qaScorecardId;
      const isDefault = news.isDefault === true;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* cci
          .createProjectsLocationsQaScorecards({
            parent,
            qaScorecardId,
            body: {
              displayName,
              description,
              isDefault,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new QaScorecardNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const displayChanged = !sameText(current.displayName, displayName);
      const descriptionChanged = (current.description ?? "") !== description;

      if (displayChanged || descriptionChanged) {
        current = yield* cci.patchProjectsLocationsQaScorecards({
          name: currentName,
          updateMask: updateMaskOf(
            displayChanged ? "display_name" : undefined,
            descriptionChanged ? "description" : undefined,
          ),
          body: {
            name: currentName,
            displayName,
            description,
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* cci
        .deleteProjectsLocationsQaScorecards({
          name: output.name,
          force: true,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
