import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Channel } from "./Channel.ts";
import type { Input } from "./Input.ts";

/**
 * Shared scaffolding for AWS Elemental MediaLive HTTP bindings.
 *
 * NOT exported from `index.ts` — every thin `{Op}Http.ts` in this service
 * is a `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the three
 * builders below. Everything except the operation and the IAM action list
 * is boilerplate: channel-scoped bindings inject the bound channel's
 * server-assigned id as the request's `ChannelId` and grant `actions` on
 * the channel ARN; input-scoped bindings do the same with `InputId` and
 * the input ARN; account-scoped bindings pass the request through and
 * grant `actions` on `*`.
 */

/**
 * Build the impl Effect for a MediaLive operation scoped to a
 * {@link Channel}: the deploy-time half grants `actions` on the bound
 * channel's ARN, and the runtime half injects the channel's id into every
 * request as `ChannelId`.
 */
export const makeMediaLiveChannelHttpBinding = <
  I extends { ChannelId: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.MediaLive.StartChannel`. */
  tag: string;
  /** The distilled operation; `ChannelId` is injected from the channel. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the channel ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (channel: Channel) {
      const ChannelId = yield* channel.channelId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${channel}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [channel.channelArn],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${channel.LogicalId})`)(function* (
        request?: Omit<I, "ChannelId">,
      ) {
        const channelId = yield* ChannelId;
        return yield* op({ ...request, ChannelId: channelId } as I);
      });
    });
  });

/**
 * Build the impl Effect for a MediaLive operation scoped to an
 * {@link Input}: the deploy-time half grants `actions` on the bound
 * input's ARN, and the runtime half injects the input's id into every
 * request as `InputId`.
 */
export const makeMediaLiveInputHttpBinding = <
  I extends { InputId: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.MediaLive.DescribeInput`. */
  tag: string;
  /** The distilled operation; `InputId` is injected from the input. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the input ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (input: Input) {
      const InputId = yield* input.inputId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${input}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [input.inputArn],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${input.LogicalId})`)(function* (
        request?: Omit<I, "InputId">,
      ) {
        const inputId = yield* InputId;
        return yield* op({ ...request, InputId: inputId } as I);
      });
    });
  });

/**
 * Build the impl Effect for an account-level MediaLive operation (e.g.
 * enumerating the account's channels or inputs). The deploy-time half
 * grants `actions` on `*` — these list operations are not scoped to a
 * single resource.
 */
export const makeMediaLiveAccountHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.MediaLive.ListChannels`. */
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
