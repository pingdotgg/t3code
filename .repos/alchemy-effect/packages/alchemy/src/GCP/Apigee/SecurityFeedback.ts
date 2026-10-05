import * as apigee from "@distilled.cloud/gcp/apigee_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  lastSegment,
  orgParent,
  organizationFromName,
  sameJson,
  toResourceId,
} from "./names.ts";
import {
  createInternalLabels,
  encodeOwnership,
  hasAlchemyLabels,
  hasOwnershipMarker,
  parseOwnership,
} from "./ownership.ts";

const MAX_NAME_LENGTH = 63;
const DEFAULT_FEEDBACK_TYPE = "EXCLUDED_DETECTION";

export type SecurityFeedbackContext = {
  /**
   * Attribute the feedback constrains.
   */
  attribute:
    | apigee.GoogleCloudApigeeV1SecurityFeedbackFeedbackContextAttributeEnum
    | (string & {});
  /**
   * Values of that attribute.
   */
  values: string[];
};

export type SecurityFeedbackProps = {
  /**
   * Apigee organization id. Defaults to the current GCP project id.
   * Immutable — changing it replaces the feedback report.
   */
  organization?: string;
  /**
   * Feedback id (the `{feedback}` segment of
   * `organizations/{org}/securityFeedback/{feedback}`). If omitted, a
   * unique name is generated from the stack, stage, and logical id.
   * Immutable — changing it replaces the report.
   */
  securityFeedbackId?: string;
  /**
   * Display name.
   */
  displayName?: string;
  /**
   * Feedback type.
   * @default "EXCLUDED_DETECTION"
   */
  feedbackType?:
    | apigee.GoogleCloudApigeeV1SecurityFeedbackFeedbackTypeEnum
    | (string & {});
  /**
   * Reason for the feedback.
   */
  reason?: apigee.GoogleCloudApigeeV1SecurityFeedbackReasonEnum | (string & {});
  /**
   * Attribute/value pairs constraining the feedback.
   */
  feedbackContexts: SecurityFeedbackContext[];
  /**
   * Free-form comment. Alchemy ownership is stored in a `[alchemy …]`
   * prefix and stripped from attributes. Feedback reports have no
   * labels field.
   */
  comment?: string;
};

export type SecurityFeedback = Resource<
  "GCP.Apigee.SecurityFeedback",
  SecurityFeedbackProps,
  {
    /** Full resource name `organizations/{org}/securityFeedback/{feedback}`. */
    name: string;
    /** Feedback id (last path segment). */
    securityFeedbackId: string;
    /** Apigee organization id. */
    organization: string;
    /** Display name. */
    displayName: string | undefined;
    /** Feedback type. */
    feedbackType: string | undefined;
    /** Reason. */
    reason: string | undefined;
    /** Constraining contexts. */
    feedbackContexts: SecurityFeedbackContext[];
    /** User comment with the Alchemy ownership prefix stripped. */
    comment: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An Advanced API Security customer feedback report.
 *
 * Feedback reports have no labels field, so Alchemy stamps ownership
 * into the comment for `list` / nuke. Name and organization are
 * identity — changing them replaces the report. Display name, type,
 * reason, contexts, and comment update in place.
 *
 * ### Creating Feedback
 * **Example:** Exclude detections from an environment
 * ```typescript
 * const feedback = yield* GCP.Apigee.SecurityFeedback("PenTest", {
 *   reason: "PENETRATION_TEST",
 *   feedbackContexts: [{
 *     attribute: "ATTRIBUTE_ENVIRONMENTS",
 *     values: ["eval"],
 *   }],
 * });
 * ```
 *
 * @resource
 * @category Apigee
 */
export const SecurityFeedback = Resource<SecurityFeedback>(
  "GCP.Apigee.SecurityFeedback",
);

export class SecurityFeedbackNotResolved extends Data.TaggedError(
  "GCP.Apigee.SecurityFeedbackNotResolved",
)<{
  name: string;
}> {}

const resourceName = (organization: string, feedbackId: string) =>
  `${orgParent(organization)}/securityFeedback/${feedbackId}`;

const feedbackIdOf = (feedback: apigee.GoogleCloudApigeeV1SecurityFeedback) =>
  lastSegment(feedback.name ?? "");

const contextsOf = (
  contexts:
    | readonly {
        attribute?: SecurityFeedbackContext["attribute"];
        values?: readonly string[];
      }[]
    | undefined,
): SecurityFeedbackContext[] =>
  (contexts ?? [])
    .filter(
      (
        context,
      ): context is {
        attribute: SecurityFeedbackContext["attribute"];
        values?: readonly string[];
      } => context.attribute !== undefined,
    )
    .map((context) => ({
      attribute: context.attribute,
      values: [...(context.values ?? [])],
    }));

const toAttrs = (
  feedback: apigee.GoogleCloudApigeeV1SecurityFeedback,
  organization: string,
) => {
  const securityFeedbackId = feedbackIdOf(feedback);
  const name = feedback.name?.includes("/")
    ? feedback.name
    : resourceName(organization, securityFeedbackId);
  const parsed = parseOwnership(feedback.comment);
  return {
    name,
    securityFeedbackId,
    organization: organizationFromName(name) ?? organization,
    displayName: feedback.displayName,
    feedbackType: feedback.feedbackType,
    reason: feedback.reason,
    feedbackContexts: contextsOf(feedback.feedbackContexts),
    comment: parsed.text,
    createTime: feedback.createTime,
    updateTime: feedback.updateTime,
  };
};

const getByName = (name: string) =>
  apigee
    .getOrganizationsSecurityFeedback({ name })
    .pipe(
      Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
        Effect.succeed(undefined),
      ),
    );

const toBody = (
  news: SecurityFeedbackProps,
  comment: string,
): apigee.GoogleCloudApigeeV1SecurityFeedback => ({
  displayName: news.displayName,
  feedbackType: news.feedbackType ?? DEFAULT_FEEDBACK_TYPE,
  reason: news.reason,
  comment,
  feedbackContexts: contextsOf(news.feedbackContexts),
});

export const SecurityFeedbackProvider = () =>
  Provider.succeed(SecurityFeedback, {
    stables: ["name", "securityFeedbackId", "organization", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.securityFeedbackId ?? output?.securityFeedbackId;
      const previousOrg = olds?.organization ?? output?.organization;
      if (
        (previousId !== undefined &&
          news.securityFeedbackId !== undefined &&
          news.securityFeedbackId !== previousId) ||
        (previousOrg !== undefined &&
          news.organization !== undefined &&
          news.organization !== previousOrg)
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const organization =
        organizationFromName(output?.name) ?? olds?.organization ?? env.project;
      const securityFeedbackId = yield* toResourceId(
        id,
        olds?.securityFeedbackId,
        output?.securityFeedbackId,
        MAX_NAME_LENGTH,
      );
      const name =
        output?.name ?? resourceName(organization, securityFeedbackId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, organization);
      const { labels } = parseOwnership(existing.comment);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* apigee.listOrganizationsSecurityFeedback
          .pages({
            parent: orgParent(env.project),
            pageSize: 100,
          })
          .pipe(
            Stream.flatMap((page) =>
              Stream.fromIterable(page.securityFeedback ?? []),
            ),
            Stream.filter((feedback) => hasOwnershipMarker(feedback.comment)),
            Stream.map((feedback) => toAttrs(feedback, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
              Effect.succeed([] as SecurityFeedback["Attributes"][]),
            ),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const organization =
        news.organization ?? output?.organization ?? env.project;
      const securityFeedbackId = yield* toResourceId(
        id,
        news.securityFeedbackId,
        output?.securityFeedbackId,
        MAX_NAME_LENGTH,
      );
      const name = resourceName(organization, securityFeedbackId);
      const ownership = yield* createInternalLabels(id);
      const desiredComment = encodeOwnership(ownership, news.comment);
      const desiredType = news.feedbackType ?? DEFAULT_FEEDBACK_TYPE;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* apigee
          .createOrganizationsSecurityFeedback({
            parent: orgParent(organization),
            securityFeedbackId,
            body: toBody(news, desiredComment),
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new SecurityFeedbackNotResolved({ name });
      }

      const displayChanged =
        (current.displayName ?? "") !== (news.displayName ?? "");
      const typeChanged = (current.feedbackType ?? "") !== desiredType;
      const reasonChanged = (current.reason ?? "") !== (news.reason ?? "");
      const commentChanged = (current.comment ?? "") !== desiredComment;
      const contextsChanged = !sameJson(
        contextsOf(current.feedbackContexts),
        contextsOf(news.feedbackContexts),
      );

      const updateMask = [
        displayChanged ? "displayName" : undefined,
        typeChanged ? "feedbackType" : undefined,
        reasonChanged ? "reason" : undefined,
        commentChanged ? "comment" : undefined,
        contextsChanged ? "feedbackContexts" : undefined,
      ].filter((field): field is string => field !== undefined);

      if (updateMask.length > 0) {
        current = yield* apigee.patchOrganizationsSecurityFeedback({
          name: current.name?.includes("/") ? current.name : name,
          updateMask: updateMask.join(","),
          body: toBody(news, desiredComment),
        });
      }

      return toAttrs(current, organization);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* apigee
        .deleteOrganizationsSecurityFeedback({ name: output.name })
        .pipe(
          Effect.catchTag(
            ["NotFound", "ApigeeResourceNotFound"],
            () => Effect.void,
          ),
        );
    }),
  });
