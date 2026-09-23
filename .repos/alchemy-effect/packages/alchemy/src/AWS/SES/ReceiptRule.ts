import * as ses from "@distilled.cloud/aws/ses";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

/**
 * Whether SES requires (`Require`) or merely prefers (`Optional`) a TLS
 * connection from the sending mail server before accepting a message that
 * matches this rule.
 */
export type ReceiptRuleTlsPolicy = ses.TlsPolicy;

/**
 * A single receipt-rule action. Pass the distilled action shape directly — one
 * of `S3Action`, `SNSAction`, `LambdaAction`, `BounceAction`, `AddHeaderAction`,
 * `StopAction`, `WorkmailAction`, or `ConnectAction`. Actions run in array
 * order; resource ARNs (bucket, topic, function) are supplied by the caller.
 */
export type ReceiptRuleAction = ses.ReceiptAction;

export interface ReceiptRuleProps {
  /**
   * Name of the receipt rule set this rule belongs to. Typically the
   * `ruleSetName` output of a `SES.ReceiptRuleSet`. Changing it replaces the
   * rule.
   */
  ruleSetName: string;
  /**
   * Name of the receipt rule. May contain letters, numbers, dashes,
   * underscores and periods, up to 64 characters. If omitted, a deterministic
   * physical name is generated from the app, stage, and logical ID. Changing
   * the name replaces the rule.
   */
  ruleName?: string;
  /**
   * Whether the rule is enabled. Disabled rules are skipped during receipt
   * processing.
   * @default true
   */
  enabled?: boolean;
  /**
   * Whether SES scans incoming messages that match this rule for spam and
   * viruses.
   * @default true
   */
  scanEnabled?: boolean;
  /**
   * Whether SES accepts email over a clear text connection (`Optional`) or
   * requires TLS (`Require`) before applying this rule.
   * @default "Optional"
   */
  tlsPolicy?: ReceiptRuleTlsPolicy;
  /**
   * Recipient email addresses or domains this rule applies to. An empty or
   * omitted list matches all recipients.
   */
  recipients?: string[];
  /**
   * Name of an existing rule in the same rule set after which this rule should
   * be placed. Omit to place the rule at the top of the rule set. Rules are
   * evaluated in order.
   */
  after?: string;
  /**
   * Ordered list of actions SES performs when a message matches this rule
   * (deliver to S3, publish to SNS, invoke Lambda, bounce, add a header, stop
   * processing, etc.).
   */
  actions?: ReceiptRuleAction[];
}

export interface ReceiptRule extends Resource<
  "AWS.SES.ReceiptRule",
  ReceiptRuleProps,
  {
    /** Name of the rule set this rule belongs to. */
    ruleSetName: string;
    /** Name of the receipt rule. */
    ruleName: string;
  },
  never,
  Providers
> {}

/**
 * An Amazon SES receipt rule — a matcher plus an ordered list of actions that
 * SES applies to inbound email received through the parent
 * `SES.ReceiptRuleSet`.
 *
 * Actions are passed as the raw distilled action shapes (no marshalling): the
 * caller supplies bucket names, topic ARNs, and function ARNs directly.
 * ### Creating Rules
 * **Example:** Deliver Matching Mail to S3
 * ```typescript
 * import * as SES from "alchemy/AWS/SES";
 *
 * const ruleSet = yield* SES.ReceiptRuleSet("Inbound", {});
 * const rule = yield* SES.ReceiptRule("ToBucket", {
 *   ruleSetName: ruleSet.ruleSetName,
 *   recipients: ["support@example.com"],
 *   actions: [
 *     { S3Action: { BucketName: "my-inbound-mail" } },
 *   ],
 * });
 * ```
 *
 * **Example:** Invoke a Lambda and Add a Header
 * ```typescript
 * const rule = yield* SES.ReceiptRule("Process", {
 *   ruleSetName: ruleSet.ruleSetName,
 *   tlsPolicy: "Require",
 *   scanEnabled: true,
 *   actions: [
 *     { AddHeaderAction: { HeaderName: "X-Inbound", HeaderValue: "ses" } },
 *     { LambdaAction: { FunctionArn: fn.functionArn, InvocationType: "Event" } },
 *   ],
 * });
 * ```
 *
 * ### Ordering Rules
 * **Example:** Place a Rule After Another
 * ```typescript
 * // A BounceAction's Sender must be a verified SES identity — SES rejects the
 * // rule with IdentityNotVerified at create/update time otherwise.
 * const first = yield* SES.ReceiptRule("First", {
 *   ruleSetName: ruleSet.ruleSetName,
 *   actions: [{ StopAction: { Scope: "RuleSet" } }],
 * });
 * const second = yield* SES.ReceiptRule("Second", {
 *   ruleSetName: ruleSet.ruleSetName,
 *   after: first.ruleName,
 *   actions: [{ BounceAction: {
 *     SmtpReplyCode: "550",
 *     Message: "Mailbox does not exist",
 *     Sender: "mailer-daemon@example.com",
 *   } }],
 * });
 * ```
 *
 * @resource
 */
export const ReceiptRule = Resource<ReceiptRule>("AWS.SES.ReceiptRule");

/**
 * The name of the rule immediately preceding `ruleName` in the rule set's
 * ordered rule list, or `undefined` when the rule is first (or absent). This is
 * the observed value of the `after` position.
 */
const observedPredecessor = (
  rules: ReadonlyArray<ses.ReceiptRule>,
  ruleName: string,
): string | undefined => {
  const index = rules.findIndex((rule) => rule.Name === ruleName);
  if (index <= 0) return undefined;
  return rules[index - 1]?.Name;
};

export const ReceiptRuleProvider = () =>
  Provider.effect(
    ReceiptRule,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: Pick<ReceiptRuleProps, "ruleName">,
      ) {
        return (
          props.ruleName ?? (yield* createPhysicalName({ id, maxLength: 64 }))
        );
      });

      const describeRule = Effect.fn(function* (
        ruleSetName: string,
        ruleName: string,
      ) {
        return yield* ses
          .describeReceiptRule({ RuleSetName: ruleSetName, RuleName: ruleName })
          .pipe(
            Effect.catchTags({
              RuleDoesNotExistException: () => Effect.succeed(undefined),
              RuleSetDoesNotExistException: () => Effect.succeed(undefined),
            }),
          );
      });

      const buildRule = (
        ruleName: string,
        props: ReceiptRuleProps,
      ): ses.ReceiptRule => ({
        Name: ruleName,
        // The classic API defaults an omitted Enabled/ScanEnabled to FALSE —
        // apply the documented defaults explicitly so an undeclared rule is
        // enabled (a silently disabled rule bounces all inbound mail).
        Enabled: props.enabled ?? true,
        TlsPolicy: props.tlsPolicy,
        Recipients: props.recipients,
        Actions: props.actions,
        ScanEnabled: props.scanEnabled ?? true,
      });

      return ReceiptRule.Provider.of({
        stables: ["ruleSetName", "ruleName"],

        // Rules are sub-resources keyed entirely by their parent rule set;
        // there is no flat account-level enumeration, so nuke handles them via
        // the parent rule set's deletion.
        list: () => Effect.succeed([]),

        read: Effect.fn(function* ({ id, olds, output }) {
          const ruleSetName = output?.ruleSetName ?? olds.ruleSetName;
          if (!ruleSetName) return undefined;
          const ruleName = output?.ruleName ?? (yield* createName(id, olds));
          const found = yield* describeRule(ruleSetName, ruleName);
          return found?.Rule ? { ruleSetName, ruleName } : undefined;
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          if (news.ruleSetName !== olds.ruleSetName) {
            return { action: "replace" } as const;
          }
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ id, news, output }) {
          const ruleSetName = news.ruleSetName;
          const ruleName = output?.ruleName ?? (yield* createName(id, news));
          const rule = buildRule(ruleName, news);

          // OBSERVE — cloud state is authoritative.
          const observed = yield* describeRule(ruleSetName, ruleName);

          // ENSURE / SYNC — a single full-replace call converges the rule's
          // matcher and actions whether it is missing or already present.
          if (observed?.Rule === undefined) {
            yield* ses
              .createReceiptRule({
                RuleSetName: ruleSetName,
                After: news.after,
                Rule: rule,
              })
              .pipe(
                Effect.catchTag("AlreadyExistsException", () =>
                  ses.updateReceiptRule({
                    RuleSetName: ruleSetName,
                    Rule: rule,
                  }),
                ),
              );
          } else {
            yield* ses.updateReceiptRule({
              RuleSetName: ruleSetName,
              Rule: rule,
            });
          }

          // SYNC POSITION — updateReceiptRule never moves the rule, so diff the
          // observed predecessor against the desired `after` and reposition
          // only on a mismatch.
          const ruleSet = yield* ses.describeReceiptRuleSet({
            RuleSetName: ruleSetName,
          });
          const predecessor = observedPredecessor(
            ruleSet.Rules ?? [],
            ruleName,
          );
          if (predecessor !== news.after) {
            yield* ses.setReceiptRulePosition({
              RuleSetName: ruleSetName,
              RuleName: ruleName,
              After: news.after,
            });
          }

          return { ruleSetName, ruleName };
        }),

        delete: Effect.fn(function* ({ output }) {
          // deleteReceiptRule is idempotent for a missing rule; a missing rule
          // set means the rule is already gone.
          yield* ses
            .deleteReceiptRule({
              RuleSetName: output.ruleSetName,
              RuleName: output.ruleName,
            })
            .pipe(
              Effect.catchTag(
                "RuleSetDoesNotExistException",
                () => Effect.void,
              ),
            );
        }),
      });
    }),
  );
