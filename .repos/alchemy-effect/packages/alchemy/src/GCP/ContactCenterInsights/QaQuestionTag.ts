import * as cci from "@distilled.cloud/gcp/contactcenterinsights_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { waitForOperation } from "./operations.ts";
import {
  encodeOwnershipLine,
  hasOwnershipMarker,
  jsonEqual,
  lastSegment,
  locationOf,
  locationParent,
  normalizeLocation,
  ownedByAlchemy,
  parseOwnership,
  toResourceId,
  updateMaskOf,
} from "./ownership.ts";

export type QaQuestionTagProps = {
  /**
   * Question tag id (the `{qa_question_tag}` segment of
   * `projects/{project}/locations/{location}/qaQuestionTags/{qa_question_tag}`).
   * If omitted, a unique id is generated. Must match `^[a-z0-9-]{4,64}$`.
   * Immutable — changing it replaces the tag.
   */
  qaQuestionTagId?: string;
  /**
   * Location (`us-central1`, …). Immutable — changing it replaces the
   * tag. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Display name. Question tags have no labels field, so Alchemy
   * ownership is stored in a `[alchemy …]` prefix and stripped from
   * attributes.
   */
  displayName?: string;
  /**
   * Scorecard question resource names this tag applies to.
   */
  qaQuestionIds?: string[];
};

export type QaQuestionTag = Resource<
  "GCP.ContactCenterInsights.QaQuestionTag",
  QaQuestionTagProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/qaQuestionTags/{qa_question_tag}`. */
    name: string;
    /** Question tag id (last path segment). */
    qaQuestionTagId: string;
    /** Location id. */
    location: string;
    /** Project id. */
    project: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Question resource names this tag applies to. */
    qaQuestionIds: string[];
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Contact Center AI Insights QA question tag used to categorize
 * questions across scorecards.
 *
 * Question tags have no labels field — Alchemy stamps ownership into the
 * display name. Location and id are immutable. Display name and linked
 * question ids update in place. Patch and delete are long-running.
 *
 * ### Creating a QA Question Tag
 * **Example:** Billing tag
 * ```typescript
 * const tag = yield* GCP.ContactCenterInsights.QaQuestionTag("Billing", {
 *   displayName: "billing",
 * });
 * ```
 *
 * @resource
 * @category ContactCenterInsights
 */
export const QaQuestionTag = Resource<QaQuestionTag>(
  "GCP.ContactCenterInsights.QaQuestionTag",
);

export class QaQuestionTagNotResolved extends Data.TaggedError(
  "GCP.ContactCenterInsights.QaQuestionTagNotResolved",
)<{
  name: string;
}> {}

const resourceName = (
  project: string,
  location: string,
  qaQuestionTagId: string,
) => `${locationParent(project, location)}/qaQuestionTags/${qaQuestionTagId}`;

const toAttrs = (
  tag: cci.GoogleCloudContactcenterinsightsV1QaQuestionTag,
  project: string,
) => {
  const name = tag.name ?? "";
  const parsed = parseOwnership(tag.displayName);
  return {
    name,
    qaQuestionTagId: lastSegment(name),
    location: locationOf(name),
    project,
    displayName: parsed.text,
    qaQuestionIds: tag.qaQuestionIds ?? [],
    createTime: tag.createTime,
    updateTime: tag.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : cci
        .getProjectsLocationsQaQuestionTags({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (parent: string, project: string) =>
  cci.listProjectsLocationsQaQuestionTags({ parent }).pipe(
    Effect.map((page) =>
      (page.qaQuestionTags ?? [])
        .filter((tag) => hasOwnershipMarker(tag.displayName))
        .map((tag) => toAttrs(tag, project)),
    ),
    Effect.catchTag("NotFound", () => Effect.succeed([])),
  );

const findByDisplayName = (parent: string, displayName: string) =>
  cci.listProjectsLocationsQaQuestionTags({ parent }).pipe(
    Effect.map((page) =>
      (page.qaQuestionTags ?? []).find(
        (tag) => tag.displayName === displayName,
      ),
    ),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

const waitAndGet = (name: string, operation: cci.GoogleLongrunningOperation) =>
  Effect.gen(function* () {
    if (operation.name !== undefined && operation.name.length > 0) {
      yield* waitForOperation(operation);
    }
    return yield* getByName(name);
  });

export const QaQuestionTagProvider = () =>
  Provider.succeed(QaQuestionTag, {
    stables: ["name", "qaQuestionTagId", "location", "project", "createTime"],

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
      const previousId = olds?.qaQuestionTagId ?? output?.qaQuestionTagId;
      if (
        previousId !== undefined &&
        news.qaQuestionTagId !== undefined &&
        news.qaQuestionTagId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const qaQuestionTagId = yield* toResourceId(
        id,
        olds?.qaQuestionTagId,
        output?.qaQuestionTagId,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location ?? env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, qaQuestionTagId);
      let existing = yield* getByName(name);
      if (existing === undefined && output?.name === undefined) {
        const ownership = yield* createInternalLabels(id);
        existing = yield* findByDisplayName(
          locationParent(env.project, location),
          encodeOwnershipLine(ownership, olds?.displayName),
        );
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.displayName))
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
      const qaQuestionTagId = yield* toResourceId(
        id,
        news.qaQuestionTagId,
        output?.qaQuestionTagId,
      );
      const name = resourceName(env.project, location, qaQuestionTagId);
      const ownership = yield* createInternalLabels(id);
      const displayName = encodeOwnershipLine(ownership, news.displayName);
      const qaQuestionIds = news.qaQuestionIds ?? [];

      let current = yield* getByName(output?.name ?? name);
      if (current === undefined) {
        current = yield* findByDisplayName(parent, displayName);
      }

      if (current === undefined) {
        const created = yield* cci
          .createProjectsLocationsQaQuestionTags({
            parent,
            qaQuestionTagId,
            body: {
              displayName,
              qaQuestionIds:
                qaQuestionIds.length > 0 ? qaQuestionIds : undefined,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? (yield* findByDisplayName(parent, displayName));
      }

      if (current === undefined) {
        return yield* new QaQuestionTagNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const displayChanged = (current.displayName ?? "") !== displayName;
      const questionsChanged = !jsonEqual(
        current.qaQuestionIds ?? [],
        qaQuestionIds,
      );

      if (displayChanged || questionsChanged) {
        const operation = yield* cci.patchProjectsLocationsQaQuestionTags({
          name: currentName,
          updateMask: updateMaskOf(
            displayChanged ? "qa_question_tag_name" : undefined,
            questionsChanged ? "qa_question_ids" : undefined,
          ),
          body: {
            name: currentName,
            displayName,
            qaQuestionIds,
          },
        });
        current = (yield* waitAndGet(currentName, operation)) ?? current;
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* cci
        .deleteProjectsLocationsQaQuestionTags({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined && (operation.name ?? "").length > 0) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
    }),
  });
