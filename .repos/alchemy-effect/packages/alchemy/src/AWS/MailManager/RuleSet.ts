import * as mm from "@distilled.cloud/aws/mailmanager";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  createTagsList,
  hasAlchemyTags,
} from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import {
  readMailManagerTags,
  retryWhileMailManagerConflict,
  sameShape,
  syncMailManagerTags,
} from "./internal.ts";

export interface RuleSetProps {
  /**
   * Name of the rule set. If omitted, a deterministic physical name is
   * generated from the app, stage, and logical ID. Renames apply in place.
   */
  ruleSetName?: string;
  /**
   * The ordered list of rules evaluated against emails arriving through an
   * ingress point associated with this rule set. Each rule pairs optional
   * conditions with one or more actions (Drop, Relay, Archive, WriteToS3,
   * Send, AddHeader, ReplaceRecipient, DeliverToMailbox, DeliverToQBusiness,
   * PublishToSns, Bounce, InvokeLambda). Updates apply in place.
   * @default []
   */
  rules?: mm.Rule[];
  /**
   * Tags applied to the rule set. Alchemy ownership tags are merged in
   * automatically.
   */
  tags?: Record<string, string>;
}

export interface RuleSet extends Resource<
  "AWS.MailManager.RuleSet",
  RuleSetProps,
  {
    /** Server-assigned ID of the rule set. */
    ruleSetId: string;
    /** ARN of the rule set. */
    ruleSetArn: string;
    /** Name of the rule set. */
    ruleSetName: string;
  },
  never,
  Providers
> {}

/**
 * An SES Mail Manager rule set — the ordered rules an ingress point applies
 * to incoming email (drop, archive, write to S3, deliver, bounce, invoke
 * Lambda, ...).
 *
 * All aspects (name, rules, tags) update in place.
 * @resource
 * @section Creating Rule Sets
 * @example Drop Everything
 * ```typescript
 * import * as MailManager from "alchemy/AWS/MailManager";
 *
 * const ruleSet = yield* MailManager.RuleSet("Inbound", {
 *   rules: [{ Name: "DropAll", Actions: [{ Drop: {} }] }],
 * });
 * ```
 *
 * @example Conditional Archive
 * ```typescript
 * const ruleSet = yield* MailManager.RuleSet("Inbound", {
 *   rules: [
 *     {
 *       Name: "ArchiveLarge",
 *       Conditions: [
 *         {
 *           NumberExpression: {
 *             Evaluate: { Attribute: "MESSAGE_SIZE" },
 *             Operator: "GREATER_THAN",
 *             Value: 1024,
 *           },
 *         },
 *       ],
 *       Actions: [{ Archive: { TargetArchive: archive.archiveId } }],
 *     },
 *   ],
 * });
 * ```
 *
 * @section Wiring to an Ingress Point
 * @example Rule Set + Traffic Policy + Ingress Point
 * ```typescript
 * const ingress = yield* MailManager.IngressPoint("Smtp", {
 *   type: "OPEN",
 *   ruleSetId: ruleSet.ruleSetId,
 *   trafficPolicyId: trafficPolicy.trafficPolicyId,
 * });
 * ```
 *
 * @section Delivering Email Events to Compute
 * @example Invoke a Lambda for Matching Mail
 * ```typescript
 * // Mail Manager has no EventBridge events or event-source mapping — email
 * // events reach compute through rule actions: InvokeLambda (direct),
 * // PublishToSns (SNS event source), or WriteToS3 (S3 event source). The
 * // role must be assumable by ses.amazonaws.com with lambda:InvokeFunction.
 * const ruleSet = yield* MailManager.RuleSet("Inbound", {
 *   rules: [
 *     {
 *       Name: "NotifyOnMail",
 *       Actions: [
 *         {
 *           InvokeLambda: {
 *             FunctionArn: fn.functionArn,
 *             InvocationType: "EVENT",
 *             RoleArn: invokeRole.roleArn,
 *           },
 *         },
 *       ],
 *     },
 *   ],
 * });
 * ```
 */
export const RuleSet = Resource<RuleSet>("AWS.MailManager.RuleSet");

export const RuleSetProvider = () =>
  Provider.effect(
    RuleSet,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { ruleSetName?: string },
      ) {
        return (
          props.ruleSetName ??
          (yield* createPhysicalName({ id, maxLength: 100 }))
        );
      });

      const getById = (ruleSetId: string) =>
        mm
          .getRuleSet({ RuleSetId: ruleSetId })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

      // Rule sets have no name-keyed Get — enumerate and match. The physical
      // name is deterministic, so this recovers identity after a lost state
      // write.
      const findByName = (name: string) =>
        mm.listRuleSets.pages({}).pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk)
              .flatMap((page) => page.RuleSets ?? [])
              .find((r) => r.RuleSetName === name),
          ),
        );

      const observe = Effect.fn(function* (
        output: RuleSet["Attributes"] | undefined,
        name: string,
      ) {
        if (output?.ruleSetId !== undefined) {
          const found = yield* getById(output.ruleSetId);
          if (found !== undefined) return found;
        }
        const summary = yield* findByName(name);
        if (summary?.RuleSetId === undefined) return undefined;
        return yield* getById(summary.RuleSetId);
      });

      const toAttrs = (ruleSet: mm.GetRuleSetResponse) => ({
        ruleSetId: ruleSet.RuleSetId,
        ruleSetArn: ruleSet.RuleSetArn,
        ruleSetName: ruleSet.RuleSetName,
      });

      return RuleSet.Provider.of({
        stables: ["ruleSetId", "ruleSetArn"],

        list: () =>
          mm.listRuleSets.pages({}).pipe(
            Stream.runCollect,
            Effect.flatMap((chunk) =>
              Effect.forEach(
                Array.from(chunk)
                  .flatMap((page) => page.RuleSets ?? [])
                  .flatMap((r) =>
                    r.RuleSetId !== undefined ? [r.RuleSetId] : [],
                  ),
                (ruleSetId) => getById(ruleSetId),
              ),
            ),
            Effect.map((results) =>
              results.flatMap((r) => (r === undefined ? [] : [toAttrs(r)])),
            ),
          ),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.ruleSetName ?? (yield* createName(id, olds ?? {}));
          const ruleSet = yield* observe(output, name);
          if (ruleSet === undefined) return undefined;
          const attrs = toAttrs(ruleSet);
          const tags = yield* readMailManagerTags(attrs.ruleSetArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        // Name and rules both update in place — no replacement triggers, so
        // the engine's default update path applies (no diff needed).

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* createName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };
          const desiredRules = news.rules ?? [];

          // 1. OBSERVE — cloud state is authoritative; output is an id cache.
          let ruleSet = yield* observe(output, name);

          // 2. ENSURE — create if missing; a Conflict race re-observes by
          //    name instead of failing.
          if (ruleSet === undefined) {
            yield* session.note(`creating rule set ${name}`);
            const created = yield* mm
              .createRuleSet({
                RuleSetName: name,
                Rules: desiredRules,
                Tags: createTagsList(desiredTags),
              })
              .pipe(
                Effect.catchTag("ConflictException", () =>
                  Effect.succeed(undefined),
                ),
              );
            ruleSet =
              created !== undefined
                ? yield* getById(created.RuleSetId)
                : yield* observe(undefined, name);
          }
          if (ruleSet === undefined) {
            return yield* Effect.fail(
              new Error(
                `Mail Manager rule set '${name}' not found after create`,
              ),
            );
          }

          // 3. SYNC — diff OBSERVED name/rules against desired; apply only
          //    the delta.
          if (
            ruleSet.RuleSetName !== name ||
            !sameShape(ruleSet.Rules, desiredRules)
          ) {
            yield* mm.updateRuleSet({
              RuleSetId: ruleSet.RuleSetId,
              RuleSetName: name,
              Rules: desiredRules,
            });
          }

          // 3b. SYNC TAGS — against observed cloud tags.
          yield* syncMailManagerTags(ruleSet.RuleSetArn, desiredTags);

          yield* session.note(ruleSet.RuleSetId);
          return {
            ruleSetId: ruleSet.RuleSetId,
            ruleSetArn: ruleSet.RuleSetArn,
            ruleSetName: name,
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          // DeleteRuleSet is natively idempotent — deleting a nonexistent
          // rule set succeeds (verified live by the delete probe test). A
          // rule set stays "in use" while a deleted ingress point finishes
          // deprovisioning — retry through the Conflict window.
          yield* retryWhileMailManagerConflict(
            mm.deleteRuleSet({ RuleSetId: output.ruleSetId }),
          ).pipe(Effect.asVoid);
        }),
      });
    }),
  );
