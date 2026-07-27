import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Output } from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { TaggableResource } from "./binding-common.ts";
import { sortByLogicalId } from "./common.ts";

/**
 * Shared scaffolding for CloudWatch HTTP bindings.
 *
 * NOT exported from `index.ts` — every single-operation `{Op}Http.ts` in
 * this service is a thin `Layer.effect(Cap, make…HttpBinding({ … }))` over
 * one of the three builders below. Everything except the operation, the IAM
 * action, and the injected identifier(s) is boilerplate:
 *
 * - {@link makeCloudWatchAccountHttpBinding} — account-level operations
 *   (`PutMetricData`, `GetMetricData`, `List*`, account-wide `Describe*`).
 *   CloudWatch metric-data and account-wide describe/list actions do not
 *   support resource-level permissions, so the deploy-time half grants
 *   `actions` on `*`.
 * - {@link makeCloudWatchResourceHttpBinding} — operations scoped to one
 *   bound resource (`GetDashboard`, `SetAlarmState`, `GetMetricStream`, …).
 *   The runtime callable injects the resource's identifier under
 *   `requestKey`; the deploy-time half grants `actions` on the resource ARN.
 * - {@link makeCloudWatchResourceSetHttpBinding} — batch toggles over a
 *   variadic set of bound resources (`EnableAlarmActions`,
 *   `DisableInsightRules`, `StartMetricStreams`, …). The runtime callable
 *   takes no request and injects the sorted resource names under `namesKey`;
 *   the deploy-time half grants `action` on every resource ARN.
 *
 * Genuinely-different bindings stay bespoke: `DescribeAlarms` (computes
 * `AlarmTypes` from the bound alarm set and accepts a filter request) and
 * `MetricSink` (a batching sink over the `PutMetricData` capability).
 */

/**
 * Build the impl Effect for an account-level CloudWatch operation. The
 * runtime callable passes the caller's request through unchanged; the
 * deploy-time half grants `actions` on `*` (these CloudWatch actions do not
 * support resource-level permissions).
 */
export const makeCloudWatchAccountHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.CloudWatch.GetMetricData`. */
  tag: string;
  /** The distilled operation, invoked with the caller's request as-is. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on `*`. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: ["*"],
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
 * Build the impl Effect for an operation scoped to a single bound CloudWatch
 * resource. The runtime callable injects the resolved `identifier` under
 * `requestKey`; the deploy-time half grants `actions` on `resourceArn`.
 */
export const makeCloudWatchResourceHttpBinding = <
  Res extends TaggableResource,
  K extends string,
  I,
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.CloudWatch.GetDashboard`. */
  tag: string;
  /** The distilled operation; the identifier is injected from the resource. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the resource ARN. */
  actions: readonly string[];
  /** Request field the resolved identifier is injected under. */
  requestKey: K;
  /** Resolve the injected identifier from the bound resource. */
  identifier: (resource: Res) => Output<string, never>;
  /** Resolve the IAM resource the actions are granted on. */
  resourceArn: (resource: Res) => Output<string, never>;
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (resource: Res) {
      const identifier = yield* options.identifier(resource);
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${resource}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [options.resourceArn(resource)],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${resource.LogicalId})`)(function* (
        request?: Omit<I, K>,
      ) {
        const input: Record<string, unknown> = { ...request };
        input[options.requestKey] = yield* identifier;
        return yield* op(input as unknown as I);
      });
    });
  });

/**
 * Build the impl Effect for a batch toggle over a variadic set of bound
 * CloudWatch resources. The runtime callable takes no request and injects
 * the resources' names (sorted by Logical ID for a deterministic binding
 * identity) under `namesKey`; the deploy-time half grants `action` on every
 * resource ARN.
 */
export const makeCloudWatchResourceSetHttpBinding = <
  Res extends TaggableResource,
  K extends string,
  I,
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.CloudWatch.EnableAlarmActions`. */
  tag: string;
  /** The distilled operation; the sorted names array is injected. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM action granted on every bound resource ARN. */
  action: string;
  /** Request field the resolved names array is injected under. */
  namesKey: K;
  /** Resolve a resource's name (the injected identifier). */
  name: (resource: Res) => Output<string, never>;
  /** Resolve a resource's ARN (the IAM resource). */
  arn: (resource: Res) => Output<string, never>;
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (...resources: [Res, ...Res[]]) {
      const sorted = sortByLogicalId(resources) as [Res, ...Res[]];
      const names = yield* Effect.forEach(sorted, (resource) =>
        options.name(resource).asEffect(),
      );
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${sorted}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [options.action],
                Resource: sorted.map((resource) => options.arn(resource)),
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${sorted})`)(function* () {
        const input: Record<string, unknown> = {};
        input[options.namesKey] = yield* Effect.forEach(names, (name) => name);
        return yield* op(input as unknown as I);
      });
    });
  });
