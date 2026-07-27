import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { AWSEnvironment } from "../Environment.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Thing } from "./Thing.ts";

/**
 * Shared scaffolding for AWS IoT HTTP bindings.
 *
 * NOT exported from `index.ts` — every near-identical `{Op}Http.ts` in this
 * service is a thin `Layer.effect(Cap, make…HttpBinding({ … }))` over one of
 * the builders below. Everything except the operation, the IAM action list,
 * and the identifier scope (account / thing / topic filter / client filter)
 * is boilerplate.
 */

const currentEnvironment = Effect.gen(function* () {
  const { accountId, region } =
    yield* AWSEnvironment.current as unknown as Effect.Effect<{
      accountId: string;
      region: string;
    }>;
  return { accountId, region };
});

/**
 * Build the impl Effect for an account-level operation (`DescribeEndpoint`,
 * `ListThings`, `ListRetainedMessages`): the runtime callable passes the
 * caller's request through unchanged and the deploy-time half grants
 * `actions` on `*` (these IoT actions do not support resource-level
 * permissions).
 */
export const makeIotAccountHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.IoT.DescribeEndpoint`. */
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
 * Build the impl Effect for a thing-scoped operation (device shadows,
 * `DescribeThing`): the runtime callable injects the bound {@link Thing}'s
 * physical name as `thingName` and the deploy-time half grants `actions` on
 * the thing ARN.
 */
export const makeIotThingHttpBinding = <
  I extends { thingName: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.IoT.GetThingShadow`. */
  tag: string;
  /** The distilled operation; `thingName` is injected from the thing. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the thing ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (thing: Thing) {
      const thingName = yield* thing.thingName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${thing}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                // `thing/<name>` authorizes the classic shadow and the
                // registry; `thing/<name>/*` authorizes NAMED shadows,
                // whose IAM resource is `thing/<thingName>/<shadowName>`.
                Resource: [
                  thing.thingArn,
                  Output.interpolate`${thing.thingArn}/*`,
                ],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${thing.LogicalId})`)(function* (
        request?: Omit<I, "thingName">,
      ) {
        return yield* op({
          ...request,
          thingName: yield* thingName,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for a topic-scoped operation (`Publish`,
 * `GetRetainedMessage`): the binding takes an MQTT topic filter, the
 * deploy-time half grants `actions` on the matching topic ARN
 * (`arn:aws:iot:{region}:{account}:topic/{filter}`, or all topics when the
 * filter is omitted), and the runtime callable passes the caller's request
 * (which carries the concrete `topic`) through unchanged.
 */
export const makeIotTopicHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.IoT.Publish`. */
  tag: string;
  /** The distilled operation, invoked with the caller's request as-is. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the topic-filter ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (topicFilter?: string) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          const { accountId, region } = yield* currentEnvironment;
          yield* host.bind`Allow(${host}, ${options.tag}(${topicFilter ?? "*"}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: [...options.actions],
                  Resource: [
                    `arn:aws:iot:${region}:${accountId}:topic/${topicFilter ?? "*"}`,
                  ],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`${options.tag}(${topicFilter ?? "*"})`)(function* (
        request: I,
      ) {
        return yield* op(request);
      });
    });
  });

/**
 * Build the impl Effect for a client-scoped MQTT connection operation
 * (`GetConnection`, `DeleteConnection`, `ListSubscriptions`,
 * `SendDirectMessage`): the binding takes a client id filter, the
 * deploy-time half grants `actions` on the matching client ARN
 * (`arn:aws:iot:{region}:{account}:client/{filter}`, or all clients when the
 * filter is omitted), and the runtime callable passes the caller's request
 * (which carries the concrete `clientId`) through unchanged.
 */
export const makeIotClientHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.IoT.GetConnection`. */
  tag: string;
  /** The distilled operation, invoked with the caller's request as-is. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the client-filter ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (clientIdFilter?: string) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          const { accountId, region } = yield* currentEnvironment;
          yield* host.bind`Allow(${host}, ${options.tag}(${clientIdFilter ?? "*"}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: [...options.actions],
                  Resource: [
                    `arn:aws:iot:${region}:${accountId}:client/${clientIdFilter ?? "*"}`,
                  ],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`${options.tag}(${clientIdFilter ?? "*"})`)(function* (
        request: I,
      ) {
        return yield* op(request);
      });
    });
  });
