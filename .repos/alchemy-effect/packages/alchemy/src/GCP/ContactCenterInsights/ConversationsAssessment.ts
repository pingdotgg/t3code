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
  sameJson,
} from "./ownership.ts";

type AgentInfo = {
  /** User-specified agent identifier. */
  agentId?: string;
  /**
   * Agent display name. Assessments have no labels field, so Alchemy
   * ownership is stored in a `[alchemy …]` prefix on this field and
   * stripped from attributes.
   */
  displayName?: string;
  /** Agent type (`HUMAN_AGENT`, `AUTOMATED_AGENT`, …). */
  agentType?:
    | "ROLE_UNSPECIFIED"
    | "HUMAN_AGENT"
    | "AUTOMATED_AGENT"
    | "END_USER"
    | "ANY_AGENT";
  /** Deprecated team string. Prefer `teams`. */
  team?: string;
  /** Team names. */
  teams?: string[];
  /** Agent location. */
  location?: string;
  /** Outcome of the agent's segment of the call. */
  dispositionCode?: string;
  /** Automated-agent deployment id. */
  deploymentId?: string;
  /** Automated-agent deployment display name. */
  deploymentDisplayName?: string;
  /** Automated-agent version id. */
  versionId?: string;
  /** Automated-agent version display name. */
  versionDisplayName?: string;
  /** Entry subagent id. */
  entrySubagentId?: string;
  /** Entry subagent display name. */
  entrySubagentDisplayName?: string;
};

export type ConversationsAssessmentProps = {
  /**
   * Parent Conversation resource name
   * (`projects/{project}/locations/{location}/conversations/{conversation}`).
   * Immutable — changing it replaces the assessment.
   */
  parent: string;
  /**
   * Agent the assessment is for. Assessments have no update RPC; changing
   * agent info replaces the assessment.
   */
  agentInfo?: AgentInfo;
};

export type ConversationsAssessment = Resource<
  "GCP.ContactCenterInsights.ConversationsAssessment",
  ConversationsAssessmentProps,
  {
    /** Full resource name. */
    name: string;
    /** Assessment id (last path segment). */
    assessmentId: string;
    /** Parent conversation resource name. */
    parent: string;
    /** Region id. */
    location: string;
    /** Project id. */
    project: string;
    /** Agent info with the Alchemy ownership prefix stripped from displayName. */
    agentInfo: AgentInfo | undefined;
    /** Server-reported assessment state. */
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
 * A quality assessment of a Contact Center Insights conversation.
 *
 * Parent conversation and agent info are immutable — there is no update
 * RPC, so changing either replaces the assessment. Assessments have no
 * labels field; Alchemy stamps ownership into `agentInfo.displayName`.
 *
 * ### Creating an Assessment
 * **Example:** Human-agent assessment
 * ```typescript
 * const assessment = yield* GCP.ContactCenterInsights.ConversationsAssessment(
 *   "QA",
 *   {
 *     parent: conversation.name,
 *     agentInfo: { agentId: "agent-1", displayName: "Ada", agentType: "HUMAN_AGENT" },
 *   },
 * );
 * ```
 *
 * @resource
 * @category ContactCenterInsights
 */
export const ConversationsAssessment = Resource<ConversationsAssessment>(
  "GCP.ContactCenterInsights.ConversationsAssessment",
);

export class ConversationsAssessmentNotResolved extends Data.TaggedError(
  "GCP.ContactCenterInsights.ConversationsAssessmentNotResolved",
)<{
  name: string;
}> {}

const toAgentInfo = (
  info:
    | cci.GoogleCloudContactcenterinsightsV1ConversationQualityMetadataAgentInfo
    | AgentInfo
    | undefined,
  stripOwnership: boolean,
): AgentInfo | undefined => {
  if (info === undefined) return undefined;
  const displayName = stripOwnership
    ? parseOwnership(info.displayName).text
    : info.displayName;
  return {
    agentId: info.agentId,
    displayName,
    agentType: info.agentType as AgentInfo["agentType"],
    team: info.team,
    teams: info.teams,
    location: info.location,
    dispositionCode: info.dispositionCode,
    deploymentId: info.deploymentId,
    deploymentDisplayName: info.deploymentDisplayName,
    versionId: info.versionId,
    versionDisplayName: info.versionDisplayName,
    entrySubagentId: info.entrySubagentId,
    entrySubagentDisplayName: info.entrySubagentDisplayName,
  };
};

const encodeAgentInfo = (
  info: AgentInfo | undefined,
  ownership: Record<string, string>,
): cci.GoogleCloudContactcenterinsightsV1ConversationQualityMetadataAgentInfo => ({
  ...(info ?? {}),
  displayName: encodeOwnershipLine(ownership, info?.displayName, 256),
});

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
    agentInfo: toAgentInfo(assessment.agentInfo, true),
    state: assessment.state,
    createTime: assessment.createTime,
    updateTime: assessment.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : cci
        .getProjectsLocationsConversationsAssessments({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAtParent = (parent: string, project: string) =>
  cci.listProjectsLocationsConversationsAssessments
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

const findOwned = (parent: string, displayName: string) =>
  cci.listProjectsLocationsConversationsAssessments
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.assessments ?? [])),
      Stream.filter(
        (assessment) => assessment.agentInfo?.displayName === displayName,
      ),
      Stream.runHead,
      Effect.map((option) =>
        option._tag === "Some" ? option.value : undefined,
      ),
      Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    );

export const ConversationsAssessmentProvider = () =>
  Provider.succeed(ConversationsAssessment, {
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
      const previousAgent = olds?.agentInfo ?? output?.agentInfo;
      if (
        previousAgent !== undefined &&
        !sameJson(
          toAgentInfo(previousAgent, false),
          toAgentInfo(news.agentInfo, false),
        )
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const existing = yield* getByName(output?.name ?? "");
      if (existing !== undefined) {
        const attrs = toAttrs(existing, env.project);
        return (yield* ownedByAlchemy(id, existing.agentInfo?.displayName))
          ? attrs
          : Unowned(attrs);
      }
      if (olds?.parent === undefined) return undefined;
      const ownership = yield* createInternalLabels(id);
      const displayName = encodeOwnershipLine(
        ownership,
        olds.agentInfo?.displayName,
      );
      const found = yield* findOwned(olds.parent, displayName);
      if (found === undefined) return undefined;
      const attrs = toAttrs(found, env.project);
      return (yield* ownedByAlchemy(id, found.agentInfo?.displayName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* listAtParent(
          `${locationParent(env.project, env.region)}/conversations/-`,
          env.project,
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const ownership = yield* createInternalLabels(id);
      const desiredAgent = encodeAgentInfo(news.agentInfo, ownership);
      const displayName = desiredAgent.displayName ?? "";

      let current = yield* getByName(output?.name ?? "");
      if (current === undefined) {
        current = yield* findOwned(news.parent, displayName);
      }

      if (current === undefined) {
        const created = yield* cci
          .createProjectsLocationsConversationsAssessments({
            parent: news.parent,
            body: { agentInfo: desiredAgent },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        current = created ?? (yield* findOwned(news.parent, displayName));
      }

      if (current === undefined) {
        return yield* new ConversationsAssessmentNotResolved({
          name: output?.name ?? `${news.parent}/assessments/-`,
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* cci
        .deleteProjectsLocationsConversationsAssessments({
          name: output.name,
          force: true,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
