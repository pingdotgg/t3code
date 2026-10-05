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
  encodeOwnershipLine,
  hasOwnershipMarker,
  lastSegment,
  locationOf,
  locationParent,
  ownedByAlchemy,
  parentOf,
  parseOwnership,
} from "./ownership.ts";

export type AgentInfo = {
  /** Opaque agent id the assessment is for. Required on create. */
  agentId?: string;
  /** Agent display name. */
  displayName?: string;
  /** Agent type (e.g. `HUMAN_AGENT`). */
  agentType?: string;
  /** Agent team. */
  team?: string;
  /** Agent teams. */
  teams?: string[];
  /** Agent location. */
  location?: string;
};

export type AuthorizedViewSetsAuthorizedViewsConversationsAssessmentProps = {
  /**
   * Parent conversation under an AuthorizedView
   * (`{authorizedView}/conversations/{conversation}`). Immutable —
   * changing it replaces the assessment.
   */
  parent: string;
  /**
   * Agent the assessment is for. Assessments have no labels or
   * description field, so Alchemy ownership is stored in
   * `agentInfo.displayName`.
   */
  agentInfo: AgentInfo;
};

export type AuthorizedViewSetsAuthorizedViewsConversationsAssessment = Resource<
  "GCP.ContactCenterInsights.AuthorizedViewSetsAuthorizedViewsConversationsAssessment",
  AuthorizedViewSetsAuthorizedViewsConversationsAssessmentProps,
  {
    /** Full resource name. */
    name: string;
    /** Assessment id (last path segment). */
    assessmentId: string;
    /** Parent conversation under the AuthorizedView. */
    parent: string;
    /** Location id. */
    location: string;
    /** Project id. */
    project: string;
    /** Assessment state. */
    state: string | undefined;
    /** Agent info with the Alchemy ownership prefix stripped from displayName. */
    agentInfo: AgentInfo | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Contact Center AI Insights quality assessment of a conversation,
 * created through an AuthorizedView.
 *
 * Assessments have no labels field and no patch API — Alchemy stamps
 * ownership into `agentInfo.displayName`. Parent conversation is
 * immutable. Reconcile is observe-then-ensure.
 *
 * ### Creating an Assessment
 * **Example:** Assess a conversation through a view
 * ```typescript
 * const assessment =
 *   yield* GCP.ContactCenterInsights.AuthorizedViewSetsAuthorizedViewsConversationsAssessment(
 *     "Qa",
 *     {
 *       parent: `${view.name}/conversations/${conversation.conversationId}`,
 *       agentInfo: { agentId: "agent-1", displayName: "Ada" },
 *     },
 *   );
 * ```
 *
 * @resource
 * @category ContactCenterInsights
 */
export const AuthorizedViewSetsAuthorizedViewsConversationsAssessment =
  Resource<AuthorizedViewSetsAuthorizedViewsConversationsAssessment>(
    "GCP.ContactCenterInsights.AuthorizedViewSetsAuthorizedViewsConversationsAssessment",
  );

export class AuthorizedViewSetsAuthorizedViewsConversationsAssessmentNotResolved extends Data.TaggedError(
  "GCP.ContactCenterInsights.AuthorizedViewSetsAuthorizedViewsConversationsAssessmentNotResolved",
)<{
  name: string;
}> {}

const agentInfoOf = (
  info:
    | cci.GoogleCloudContactcenterinsightsV1ConversationQualityMetadataAgentInfo
    | undefined,
): AgentInfo | undefined => {
  if (info === undefined) return undefined;
  const parsed = parseOwnership(info.displayName);
  return {
    agentId: info.agentId,
    displayName: parsed.text,
    agentType: info.agentType,
    team: info.team,
    teams: info.teams,
    location: info.location,
  };
};

const toAttrs = (
  assessment: cci.GoogleCloudContactcenterinsightsV1Assessment,
  project: string,
) => {
  const name = assessment.name ?? "";
  return {
    name,
    assessmentId: lastSegment(name),
    parent: parentOf(name),
    location: locationOf(name),
    project,
    state: assessment.state,
    agentInfo: agentInfoOf(assessment.agentInfo),
    createTime: assessment.createTime,
    updateTime: assessment.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : cci
        .getProjectsLocationsAuthorizedViewSetsAuthorizedViewsConversationsAssessments(
          { name },
        )
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAtParent = (parent: string, project: string) =>
  cci.listProjectsLocationsAuthorizedViewSetsAuthorizedViewsConversationsAssessments
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.assessments ?? [])),
      Stream.filter((assessment) =>
        hasOwnershipMarker(assessment.agentInfo?.displayName),
      ),
      Stream.map((assessment) => toAttrs(assessment, project)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const findOwned = (
  parent: string,
  displayName: string,
  agentId: string | undefined,
) =>
  cci.listProjectsLocationsAuthorizedViewSetsAuthorizedViewsConversationsAssessments
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.assessments ?? [])),
      Stream.filter(
        (assessment) =>
          assessment.agentInfo?.displayName === displayName &&
          (agentId === undefined || assessment.agentInfo?.agentId === agentId),
      ),
      Stream.runHead,
      Effect.map((option) =>
        option._tag === "Some" ? option.value : undefined,
      ),
      Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    );

export const AuthorizedViewSetsAuthorizedViewsConversationsAssessmentProvider =
  () =>
    Provider.succeed(AuthorizedViewSetsAuthorizedViewsConversationsAssessment, {
      stables: [
        "name",
        "assessmentId",
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
        const previousAgent =
          olds?.agentInfo?.agentId ?? output?.agentInfo?.agentId;
        if (
          previousAgent !== undefined &&
          news.agentInfo.agentId !== undefined &&
          news.agentInfo.agentId !== previousAgent
        ) {
          return { action: "replace" as const, deleteFirst: false };
        }
        return undefined;
      }),

      read: Effect.fn(function* ({ id, olds, output }) {
        const env = yield* GcpEnvironment.current;
        let existing = yield* getByName(output?.name ?? "");
        if (existing === undefined && olds?.parent !== undefined) {
          const ownership = yield* createInternalLabels(id);
          existing = yield* findOwned(
            olds.parent,
            encodeOwnershipLine(ownership, olds.agentInfo?.displayName),
            olds.agentInfo?.agentId,
          );
        }
        if (existing === undefined) return undefined;
        const attrs = toAttrs(existing, env.project);
        return (yield* ownedByAlchemy(id, existing.agentInfo?.displayName))
          ? attrs
          : Unowned(attrs);
      }),

      list: () =>
        Effect.gen(function* () {
          const env = yield* GcpEnvironment.current;
          const viewsParent = `${locationParent(env.project, env.region)}/authorizedViewSets/-`;
          const views =
            yield* cci.listProjectsLocationsAuthorizedViewSetsAuthorizedViews
              .pages({ parent: viewsParent, pageSize: 100 })
              .pipe(
                Stream.flatMap((page) =>
                  Stream.fromIterable(page.authorizedViews ?? []),
                ),
                Stream.map((view) => view.name ?? ""),
                Stream.filter((name) => name.length > 0),
                Stream.runCollect,
                Effect.map((chunk) => Array.from(chunk)),
                Effect.catchTag("NotFound", () =>
                  Effect.succeed([] as string[]),
                ),
              );
          const pages = yield* Effect.forEach(
            views,
            (view) => listAtParent(`${view}/conversations/-`, env.project),
            { concurrency: 4 },
          );
          return pages.flat();
        }),

      reconcile: Effect.fn(function* ({ id, news, output }) {
        const env = yield* GcpEnvironment.current;
        const ownership = yield* createInternalLabels(id);
        const displayName = encodeOwnershipLine(
          ownership,
          news.agentInfo.displayName,
        );
        const agentInfo = {
          ...news.agentInfo,
          displayName,
        };

        let current = yield* getByName(output?.name ?? "");
        if (current === undefined) {
          current = yield* findOwned(
            news.parent,
            displayName,
            news.agentInfo.agentId,
          );
        }

        if (current === undefined) {
          const created = yield* cci
            .createProjectsLocationsAuthorizedViewSetsAuthorizedViewsConversationsAssessments(
              {
                parent: news.parent,
                body: { agentInfo },
              },
            )
            .pipe(
              Effect.catchTag("Conflict", () =>
                findOwned(news.parent, displayName, news.agentInfo.agentId),
              ),
            );
          current = created ?? undefined;
        }

        if (current === undefined) {
          return yield* new AuthorizedViewSetsAuthorizedViewsConversationsAssessmentNotResolved(
            {
              name: output?.name ?? `${news.parent}/assessments/-`,
            },
          );
        }

        return toAttrs(current, env.project);
      }),

      delete: Effect.fn(function* ({ output }) {
        yield* cci
          .deleteProjectsLocationsAuthorizedViewSetsAuthorizedViewsConversationsAssessments(
            { name: output.name, force: true },
          )
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
      }),
    });
