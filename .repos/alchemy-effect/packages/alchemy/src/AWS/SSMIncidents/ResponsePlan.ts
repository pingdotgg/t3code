import * as incidents from "@distilled.cloud/aws/ssm-incidents";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

export interface ResponsePlanProps {
  /**
   * The name of the response plan. Must be unique in the account and can't
   * contain spaces. Changing it replaces the response plan.
   *
   * @default ${app}-${id}-${stage}-${suffix}
   */
  name?: string;

  /**
   * A human-readable name shown in the Incident Manager console.
   */
  displayName?: string;

  /**
   * Details used to create the incident when this response plan starts an
   * incident: title, impact (1 = critical … 5 = no impact), optional summary,
   * dedupe string, SNS notification targets, and tags applied to the incident
   * record.
   */
  incidentTemplate: incidents.IncidentTemplate;

  /**
   * The AWS Chatbot chat channel used for collaboration during an incident.
   */
  chatChannel?: incidents.ChatChannel;

  /**
   * ARNs of the Incident Manager contacts and escalation plans that the
   * response plan engages during an incident.
   */
  engagements?: string[];

  /**
   * The Systems Manager Automation runbooks to run at the beginning of the
   * incident.
   */
  actions?: incidents.Action[];

  /**
   * PagerDuty integrations to associate with the response plan.
   */
  integrations?: incidents.Integration[];

  /**
   * Tags applied to the response plan. Alchemy ownership tags are merged in
   * automatically.
   */
  tags?: Record<string, string>;
}

/** @resource */
export interface ResponsePlan extends Resource<
  "AWS.SSMIncidents.ResponsePlan",
  ResponsePlanProps,
  {
    /** ARN of the response plan. */
    arn: string;
    /** Name of the response plan. */
    name: string;
  },
  never,
  Providers
> {}

/**
 * An Incident Manager response plan — the template that automates the initial
 * response to incidents by engaging contacts, starting chat-channel
 * collaboration, and running Automation runbooks.
 *
 * Requires the account's Incident Manager replication set
 * (`SSMIncidents.ReplicationSet`) to exist.
 *
 * @section Creating Response Plans
 * @example Minimal response plan
 * ```typescript
 * const replicationSet = yield* SSMIncidents.ReplicationSet("Incidents", {});
 * const plan = yield* SSMIncidents.ResponsePlan("Critical", {
 *   incidentTemplate: { title: "Critical failure", impact: 1 },
 * });
 * ```
 *
 * @example Response plan with engagements and chat channel
 * ```typescript
 * const plan = yield* SSMIncidents.ResponsePlan("Sev1", {
 *   displayName: "Severity 1 response",
 *   incidentTemplate: {
 *     title: "Sev1 incident",
 *     impact: 1,
 *     summary: "Automated Sev1 response",
 *     notificationTargets: [{ snsTopicArn: topic.topicArn }],
 *   },
 *   engagements: [oncall.contactArn],
 *   chatChannel: { chatbotSns: [topic.topicArn] },
 * });
 * ```
 */
const ResponsePlanResource = Resource<ResponsePlan>(
  "AWS.SSMIncidents.ResponsePlan",
);

export { ResponsePlanResource as ResponsePlan };

// Normalized deep-equality for desired-vs-observed sync comparisons —
// tolerates key ordering and treats absent optional lists as empty.
const normalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([l], [r]) => l.localeCompare(r))
        .map(([k, v]) => [k, normalize(v)]),
    );
  }
  return value;
};
const same = (l: unknown, r: unknown) =>
  JSON.stringify(normalize(l)) === JSON.stringify(normalize(r));

export const ResponsePlanProvider = () =>
  Provider.effect(
    ResponsePlanResource,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { name?: string },
      ) {
        // Response plan names can't contain spaces; physical names are
        // DNS-safe already.
        return (
          props.name ?? (yield* createPhysicalName({ id, maxLength: 200 }))
        );
      });

      const findArnByName = (name: string) =>
        incidents.listResponsePlans.items({}).pipe(
          Stream.filter((summary) => summary.name === name),
          Stream.take(1),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)[0]?.arn),
        );

      const getPlan = (arn: string) =>
        incidents
          .getResponsePlan({ arn })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

      const observe = Effect.fn(function* (
        name: string,
        arn: string | undefined,
      ) {
        if (arn !== undefined) {
          const byArn = yield* getPlan(arn);
          if (byArn !== undefined) return byArn;
        }
        const found = yield* findArnByName(name);
        return found === undefined ? undefined : yield* getPlan(found);
      });

      const readTags = (arn: string) =>
        incidents.listTagsForResource({ resourceArn: arn }).pipe(
          Effect.map(
            (r) =>
              Object.fromEntries(
                Object.entries(r.tags).filter(
                  (e): e is [string, string] => e[1] !== undefined,
                ),
              ) as Record<string, string>,
          ),
          Effect.catch(() => Effect.succeed<Record<string, string>>({})),
        );

      return ResponsePlanResource.Provider.of({
        stables: ["arn", "name"],

        list: () =>
          incidents.listResponsePlans.items({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).map((summary) => ({
                arn: summary.arn,
                name: summary.name,
              })),
            ),
          ),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.name ?? (yield* createName(id, olds ?? {}));
          const plan = yield* observe(name, output?.arn);
          if (plan === undefined) return undefined;
          const attrs = { arn: plan.arn, name: plan.name };
          const tags = yield* readTags(plan.arn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        // The name is create-only; everything else updates in place.
        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (oldName !== newName) return { action: "replace" } as const;
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.name ?? (yield* createName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. OBSERVE
          let plan = yield* observe(name, output?.arn);

          // 2. ENSURE — create if missing; tolerate the already-exists race.
          if (plan === undefined) {
            yield* session.note(`creating response plan ${name}`);
            const arn = yield* incidents
              .createResponsePlan({
                name,
                displayName: news.displayName,
                incidentTemplate: news.incidentTemplate,
                chatChannel: news.chatChannel,
                engagements: news.engagements,
                actions: news.actions,
                integrations: news.integrations,
                tags: desiredTags,
              })
              .pipe(
                Effect.map((r) => r.arn),
                Effect.catchTag("ConflictException", () =>
                  findArnByName(name).pipe(Effect.map((found) => found!)),
                ),
              );
            plan = (yield* getPlan(arn))!;
          }
          const arn = plan.arn;

          // 3. SYNC — diff each mutable aspect of the OBSERVED plan against
          //    the desired state; call updateResponsePlan only on a delta.
          //    Empty strings / empty arrays clear a previously-set value.
          const desired = {
            displayName: news.displayName ?? "",
            incidentTemplate: {
              title: news.incidentTemplate.title,
              impact: news.incidentTemplate.impact,
              summary: news.incidentTemplate.summary ?? "",
              dedupeString: news.incidentTemplate.dedupeString ?? "",
              notificationTargets:
                news.incidentTemplate.notificationTargets ?? [],
              incidentTags: news.incidentTemplate.incidentTags ?? {},
            },
            engagements: [...(news.engagements ?? [])].sort(),
            actions: news.actions ?? [],
            integrations: news.integrations ?? [],
          };
          const observed = {
            displayName: plan.displayName ?? "",
            incidentTemplate: {
              title: plan.incidentTemplate.title,
              impact: plan.incidentTemplate.impact,
              summary: plan.incidentTemplate.summary ?? "",
              dedupeString: plan.incidentTemplate.dedupeString ?? "",
              notificationTargets:
                plan.incidentTemplate.notificationTargets ?? [],
              incidentTags: plan.incidentTemplate.incidentTags ?? {},
            },
            engagements: [...(plan.engagements ?? [])].sort(),
            actions: plan.actions ?? [],
            integrations: plan.integrations ?? [],
          };
          const chatChannelDelta =
            news.chatChannel !== undefined &&
            !same(plan.chatChannel, news.chatChannel);
          if (!same(desired, observed) || chatChannelDelta) {
            yield* incidents.updateResponsePlan({
              arn,
              displayName: desired.displayName,
              incidentTemplateTitle: desired.incidentTemplate.title,
              incidentTemplateImpact: desired.incidentTemplate.impact,
              incidentTemplateSummary: desired.incidentTemplate.summary,
              incidentTemplateDedupeString:
                desired.incidentTemplate.dedupeString,
              incidentTemplateNotificationTargets:
                desired.incidentTemplate.notificationTargets,
              incidentTemplateTags: desired.incidentTemplate.incidentTags,
              chatChannel: news.chatChannel,
              engagements: desired.engagements,
              actions: desired.actions,
              integrations: desired.integrations,
            });
          }

          // 3b. SYNC tags — diff against OBSERVED cloud tags.
          const currentTags = yield* readTags(arn);
          const { upsert, removed } = diffTags(currentTags, desiredTags);
          if (upsert.length > 0) {
            yield* incidents.tagResource({
              resourceArn: arn,
              tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
            });
          }
          if (removed.length > 0) {
            yield* incidents.untagResource({
              resourceArn: arn,
              tagKeys: removed,
            });
          }

          yield* session.note(arn);
          return { arn, name };
        }),

        delete: Effect.fn(function* ({ output }) {
          // deleteResponsePlan is idempotent for missing plans; tolerate the
          // typed not-found in case AWS starts returning it.
          yield* incidents
            .deleteResponsePlan({ arn: output.arn })
            .pipe(Effect.asVoid);
        }),
      });
    }),
  );
