import * as cci from "@distilled.cloud/gcp/contactcenterinsights_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { resourceNameFromOperation, waitForOperation } from "./operations.ts";
import {
  encodeOwnership,
  encodeOwnershipLine,
  hasOwnershipMarker,
  lastSegment,
  locationOf,
  locationParent,
  ownedByAlchemy,
  parentOf,
  parseOwnership,
} from "./ownership.ts";

export type IssueModelsIssueProps = {
  /**
   * Parent IssueModel resource name
   * (`projects/{project}/locations/{location}/issueModels/{issue_model}`).
   * Immutable — changing it replaces the issue.
   */
  parent: string;
  /**
   * Representative name.
   */
  displayName?: string;
  /**
   * Representative description. Issues have no labels field, so Alchemy
   * ownership is stored in a `[alchemy …]` prefix and stripped from
   * attributes.
   */
  displayDescription?: string;
};

export type IssueModelsIssue = Resource<
  "GCP.ContactCenterInsights.IssueModelsIssue",
  IssueModelsIssueProps,
  {
    /** Full resource name. */
    name: string;
    /** Issue id (last path segment). */
    issueId: string;
    /** Parent issue model resource name. */
    parent: string;
    /** Region id. */
    location: string;
    /** Project id. */
    project: string;
    /** User-facing display name. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    displayDescription: string | undefined;
    /** Sample representative utterances. */
    sampleUtterances: string[];
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An issue under a Contact Center Insights issue model.
 *
 * Parent issue model is immutable. Issues have no labels field — Alchemy
 * stamps ownership into `displayDescription`. Display name and description
 * update in place. Create is a long-running operation; the parent model
 * must be undeployed.
 *
 * ### Creating an Issue
 * **Example:** Billing issue under a model
 * ```typescript
 * const issue = yield* GCP.ContactCenterInsights.IssueModelsIssue("Billing", {
 *   parent: model.name,
 *   displayName: "billing",
 *   displayDescription: "questions about invoices",
 * });
 * ```
 *
 * @resource
 * @category ContactCenterInsights
 */
export const IssueModelsIssue = Resource<IssueModelsIssue>(
  "GCP.ContactCenterInsights.IssueModelsIssue",
);

export class IssueModelsIssueNotResolved extends Data.TaggedError(
  "GCP.ContactCenterInsights.IssueModelsIssueNotResolved",
)<{
  name: string;
}> {}

const toAttrs = (
  issue: cci.GoogleCloudContactcenterinsightsV1Issue,
  project: string,
) => {
  const name = issue.name ?? "";
  const parsed = parseOwnership(issue.displayDescription);
  return {
    name,
    issueId: lastSegment(name),
    parent: parentOf(name),
    location: locationOf(name),
    project,
    displayName: issue.displayName,
    displayDescription: parsed.text,
    sampleUtterances: issue.sampleUtterances ?? [],
    createTime: issue.createTime,
    updateTime: issue.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : cci
        .getProjectsLocationsIssueModelsIssues({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((issue) =>
      issue
        ? Effect.succeed(issue)
        : Effect.fail(new IssueModelsIssueNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.ContactCenterInsights.IssueModelsIssueNotResolved",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const listModels = (parent: string) =>
  cci.listProjectsLocationsIssueModels({ parent }).pipe(
    Effect.map((page) =>
      (page.issueModels ?? [])
        .map((model) => model.name ?? "")
        .filter((name) => name.length > 0),
    ),
    Effect.catchTag("NotFound", () => Effect.succeed([] as string[])),
  );

const listAtParent = (parent: string, project: string) =>
  cci.listProjectsLocationsIssueModelsIssues({ parent }).pipe(
    Effect.map((page) =>
      (page.issues ?? [])
        .filter((issue) => hasOwnershipMarker(issue.displayDescription))
        .map((issue) => toAttrs(issue, project)),
    ),
    Effect.catchTag("NotFound", () => Effect.succeed([])),
  );

const findOwned = (
  parent: string,
  displayDescription: string,
  displayName: string | undefined,
) =>
  cci.listProjectsLocationsIssueModelsIssues({ parent }).pipe(
    Effect.map((page) =>
      (page.issues ?? []).find(
        (issue) =>
          issue.displayDescription === displayDescription ||
          (displayName !== undefined && issue.displayName === displayName),
      ),
    ),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

export const IssueModelsIssueProvider = () =>
  Provider.succeed(IssueModelsIssue, {
    stables: ["name", "issueId", "parent", "location", "project", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.parent ?? output?.parent;
      if (previousParent !== undefined && news.parent !== previousParent) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const existing = yield* getByName(output?.name ?? "");
      if (existing !== undefined) {
        const attrs = toAttrs(existing, env.project);
        return (yield* ownedByAlchemy(id, existing.displayDescription))
          ? attrs
          : Unowned(attrs);
      }
      if (olds?.parent === undefined) return undefined;
      const ownership = yield* createInternalLabels(id);
      const displayDescription = encodeOwnership(
        ownership,
        olds.displayDescription,
      );
      const found = yield* findOwned(
        olds.parent,
        displayDescription,
        olds.displayName,
      );
      if (found === undefined) return undefined;
      const attrs = toAttrs(found, env.project);
      return (yield* ownedByAlchemy(id, found.displayDescription))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const models = yield* listModels(
          locationParent(env.project, env.region),
        );
        const pages = yield* Effect.forEach(
          models,
          (parent) => listAtParent(parent, env.project),
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const ownership = yield* createInternalLabels(id);
      const displayDescription = encodeOwnership(
        ownership,
        news.displayDescription,
      );
      const displayName =
        news.displayName ??
        encodeOwnershipLine(ownership, news.displayDescription);

      let current = yield* getByName(output?.name ?? "");
      if (current === undefined) {
        current = yield* findOwned(
          news.parent,
          displayDescription,
          displayName,
        );
      }

      if (current === undefined) {
        const created = yield* cci
          .createProjectsLocationsIssueModelsIssues({
            parent: news.parent,
            body: {
              displayName,
              displayDescription,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          const done = yield* waitForOperation(created);
          const createdName = resourceNameFromOperation(done) ?? "";
          if (createdName.length > 0) {
            current = yield* waitUntilExists(createdName);
          }
        }
        if (current === undefined) {
          current = yield* findOwned(
            news.parent,
            displayDescription,
            displayName,
          );
        }
      }

      if (current === undefined) {
        return yield* new IssueModelsIssueNotResolved({
          name: output?.name ?? `${news.parent}/issues/-`,
        });
      }

      const name = current.name ?? "";
      const displayChanged = (current.displayName ?? "") !== displayName;
      const descriptionChanged =
        (current.displayDescription ?? "") !== displayDescription;

      if (displayChanged || descriptionChanged) {
        current = yield* cci.patchProjectsLocationsIssueModelsIssues({
          name,
          updateMask: [
            displayChanged ? "display_name" : undefined,
            descriptionChanged ? "display_description" : undefined,
          ]
            .filter((field): field is string => field !== undefined)
            .join(","),
          body: {
            name,
            displayName,
            displayDescription,
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* cci
        .deleteProjectsLocationsIssueModelsIssues({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
