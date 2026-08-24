import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { AWSEnvironment } from "../Environment.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { EventBus } from "./EventBus.ts";
import type { Rule } from "./Rule.ts";

/**
 * Shared scaffolding for the EventBridge runtime bindings.
 *
 * NOT exported from `index.ts` — every single-operation `{Op}Http.ts` in
 * this service is a thin `Layer.effect(Cap, makeEventBridge…HttpBinding({ … }))`
 * over one of the three builders below. Everything except the operation, the
 * IAM action list, and the injected identifier(s) is boilerplate:
 *
 * - {@link makeEventBridgeAccountHttpBinding} — account-level operations
 *   (`ListEventBuses`, `TestEventPattern`, `ListRuleNamesByTarget`, replay
 *   reads). The runtime callable passes the caller's request through
 *   unchanged; the deploy-time half grants `actions` on `resources`
 *   (default `*` — most EventBridge list/test actions do not support
 *   resource-level permissions).
 * - {@link makeEventBridgeBusHttpBinding} — operations scoped to an optional
 *   bound {@link EventBus} (`DescribeEventBus`, `ListRules`). The runtime
 *   callable injects the bus name under `busNameKey` (omitted for the
 *   default bus); the deploy-time half grants `actions` on the bus ARN, or
 *   the account default bus ARN when no bus is bound.
 * - {@link makeEventBridgeRuleHttpBinding} — operations scoped to a bound
 *   {@link Rule} (`DescribeRule`, `ListTargetsByRule`, `EnableRule`,
 *   `DisableRule`). The runtime callable injects the rule name under
 *   `ruleNameKey` and the bus name under `EventBusName` (omitted for the
 *   default bus); the deploy-time half grants `actions` on the rule ARN.
 *
 * Genuinely-different bindings stay bespoke: `PutEvents` (per-entry bus-name
 * injection), `BusSink` (a batching sink over `PutEvents`), and
 * `StartReplay` (archive-scoped with a replay-wildcard grant).
 */

/**
 * Build the impl Effect for an account-level EventBridge operation. The
 * runtime callable passes the caller's request through unchanged; the
 * deploy-time half grants `actions` on `resources` (default `*`).
 */
export const makeEventBridgeAccountHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.EventBridge.ListEventBuses`. */
  tag: string;
  /** The distilled operation, invoked with the caller's request as-is. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on `resources`. */
  actions: readonly string[];
  /**
   * Resolve the IAM resources the actions are granted on, given the ambient
   * account and region (e.g. a `replay/*` ARN). Defaults to `["*"]`.
   */
  resources?: (env: { accountId: string; region: string }) => readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          const { accountId, region } =
            yield* AWSEnvironment.current as unknown as Effect.Effect<{
              accountId: string;
              region: string;
            }>;
          yield* host.bind`Allow(${host}, ${options.tag}())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: options.resources
                  ? [...options.resources({ accountId, region })]
                  : ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn(options.tag)(function* (request?: I) {
        return yield* op((request ?? {}) as I);
      });
    });
  });

/**
 * Build the impl Effect for an EventBridge operation scoped to an optional
 * bound {@link EventBus}. The runtime callable injects the bus name under
 * `busNameKey` (omitted for the default bus); the deploy-time half grants
 * `actions` on the bus ARN, or the account default bus ARN when no bus is
 * bound.
 */
export const makeEventBridgeBusHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.EventBridge.DescribeEventBus`. */
  tag: string;
  /** The distilled operation; the bus name is injected from the bound bus. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the bus ARN. */
  actions: readonly string[];
  /** Request field the bound bus's name is injected under. */
  busNameKey: string;
  /**
   * Override the IAM resources the actions are granted on. Some bus-scoped
   * operations (`events:ListRules`) do not support resource-level
   * permissions and must be granted on `*`; the default is the bound bus's
   * ARN (or the account default bus ARN when no bus is bound).
   */
  resources?: (env: { accountId: string; region: string }) => readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (bus?: EventBus) {
      const EventBusName = bus ? yield* bus.eventBusName : undefined;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          const { accountId, region } =
            yield* AWSEnvironment.current as unknown as Effect.Effect<{
              accountId: string;
              region: string;
            }>;
          // Pass the ARN as an unresolved Output — binding data is resolved
          // by the engine before the host reconciles. Eagerly yielding here
          // (during plan) produces a deferred object that serializes into an
          // invalid IAM policy (MalformedPolicyDocumentException).
          const resource = bus
            ? Output.interpolate`${bus.eventBusArn}`
            : (`arn:aws:events:${region}:${accountId}:event-bus/default` as const);

          yield* host.bind`Allow(${host}, ${options.tag}(${bus ?? "default"}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: [...options.actions],
                  Resource: options.resources
                    ? [...options.resources({ accountId, region })]
                    : [resource],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`${options.tag}(${bus?.LogicalId})`)(function* (
        request?: Partial<I>,
      ) {
        const eventBusName = EventBusName ? yield* EventBusName : undefined;
        const input: Record<string, unknown> = { ...request };
        if (eventBusName !== undefined && eventBusName !== "default") {
          input[options.busNameKey] = eventBusName;
        }
        return yield* op(input as I);
      });
    });
  });

/**
 * Build the impl Effect for an EventBridge operation scoped to a bound
 * {@link Rule}. The runtime callable injects the rule name under
 * `ruleNameKey` and the rule's bus name under `EventBusName` (omitted for
 * the default bus); the deploy-time half grants `actions` on the rule ARN.
 */
export const makeEventBridgeRuleHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.EventBridge.DescribeRule`. */
  tag: string;
  /** The distilled operation; the rule and bus names are injected. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the rule ARN. */
  actions: readonly string[];
  /** Request field the bound rule's name is injected under. */
  ruleNameKey: string;
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (rule: Rule) {
      const RuleName = yield* rule.ruleName;
      const EventBusName = yield* rule.eventBusName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${rule}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [rule.ruleArn],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${rule.LogicalId})`)(function* (
        request?: Partial<I>,
      ) {
        const ruleName = yield* RuleName;
        const eventBusName = yield* EventBusName;
        const input: Record<string, unknown> = { ...request };
        input[options.ruleNameKey] = ruleName;
        if (eventBusName !== "default") {
          input.EventBusName = eventBusName;
        }
        return yield* op(input as I);
      });
    });
  });
