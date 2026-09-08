import * as ses from "@distilled.cloud/aws/ses";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface ReceiptRuleSetProps {
  /**
   * Name of the receipt rule set. May contain letters, numbers, dashes,
   * underscores and periods, up to 64 characters, and must start and end with
   * a letter or number. If omitted, a deterministic physical name is generated
   * from the app, stage, and logical ID. Changing the name replaces the rule
   * set.
   */
  ruleSetName?: string;
}

export interface ReceiptRuleSet extends Resource<
  "AWS.SES.ReceiptRuleSet",
  ReceiptRuleSetProps,
  {
    /** Name of the receipt rule set. */
    ruleSetName: string;
  },
  never,
  Providers
> {}

/**
 * An Amazon SES receipt rule set — the ordered container for the receipt rules
 * that decide what happens to inbound email (deliver to S3, invoke a Lambda,
 * publish to SNS, bounce, etc.).
 *
 * A rule set is an empty container on creation; add `SES.ReceiptRule`s to it
 * and point the account at it with `SES.ActiveReceiptRuleSet` to start
 * processing mail. Email receiving is only available in a subset of regions
 * (e.g. `us-east-1`, `us-west-2`, `eu-west-1`).
 * ### Creating Rule Sets
 * **Example:** Basic Rule Set
 * ```typescript
 * import * as SES from "alchemy/AWS/SES";
 *
 * const ruleSet = yield* SES.ReceiptRuleSet("Inbound", {});
 * ```
 *
 * **Example:** Named Rule Set
 * ```typescript
 * const ruleSet = yield* SES.ReceiptRuleSet("Inbound", {
 *   ruleSetName: "my-inbound-rules",
 * });
 * ```
 *
 * ### Activating a Rule Set
 * **Example:** Point the Account at a Rule Set
 * ```typescript
 * const ruleSet = yield* SES.ReceiptRuleSet("Inbound", {});
 * yield* SES.ActiveReceiptRuleSet("Active", {
 *   ruleSetName: ruleSet.ruleSetName,
 * });
 * ```
 *
 * @resource
 */
export const ReceiptRuleSet = Resource<ReceiptRuleSet>(
  "AWS.SES.ReceiptRuleSet",
);

export const ReceiptRuleSetProvider = () =>
  Provider.effect(
    ReceiptRuleSet,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: Pick<ReceiptRuleSetProps, "ruleSetName">,
      ) {
        return (
          props.ruleSetName ??
          (yield* createPhysicalName({ id, maxLength: 64 }))
        );
      });

      const describe = Effect.fn(function* (name: string) {
        return yield* ses
          .describeReceiptRuleSet({ RuleSetName: name })
          .pipe(
            Effect.catchTag("RuleSetDoesNotExistException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      return ReceiptRuleSet.Provider.of({
        stables: ["ruleSetName"],

        // Account/region-scoped: enumerate every rule set so leaked test
        // resources are cleaned by nuke. Classic receipt rule sets carry no
        // tags, so there is no ownership signal to filter on.
        list: () =>
          Effect.gen(function* () {
            const rows: { ruleSetName: string }[] = [];
            let nextToken: string | undefined;
            do {
              const page = yield* ses.listReceiptRuleSets({
                NextToken: nextToken,
              });
              for (const set of page.RuleSets ?? []) {
                if (set.Name) rows.push({ ruleSetName: set.Name });
              }
              nextToken = page.NextToken;
            } while (nextToken);
            return rows;
          }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.ruleSetName ?? (yield* createName(id, olds));
          const found = yield* describe(name);
          // Receipt rule sets are untagged in the classic API, so there is no
          // way to distinguish a foreign rule set from one we own. Existence
          // at our deterministic name is treated as ownership.
          return found ? { ruleSetName: name } : undefined;
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ id, news, output }) {
          const name = output?.ruleSetName ?? (yield* createName(id, news));

          // OBSERVE — cloud state is authoritative.
          const observed = yield* describe(name);

          // ENSURE — create if missing; AlreadyExists is a race, not a failure.
          if (observed === undefined) {
            yield* ses
              .createReceiptRuleSet({ RuleSetName: name })
              .pipe(
                Effect.catchTag("AlreadyExistsException", () =>
                  Effect.succeed({}),
                ),
              );
          }

          // A rule set has no mutable aspects of its own; rules are separate
          // `SES.ReceiptRule` resources.
          return { ruleSetName: name };
        }),

        delete: Effect.fn(function* ({ output }) {
          // deleteReceiptRuleSet is idempotent for a missing set; the active
          // set cannot be deleted and surfaces as a typed CannotDeleteException.
          yield* ses.deleteReceiptRuleSet({
            RuleSetName: output.ruleSetName,
          });
        }),
      });
    }),
  );
