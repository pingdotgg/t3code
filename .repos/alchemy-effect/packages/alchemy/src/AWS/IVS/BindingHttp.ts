import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Channel } from "./Channel.ts";

/**
 * Shared scaffolding for Amazon IVS stream data-plane HTTP bindings.
 *
 * NOT exported from `index.ts` — every thin `{Op}Http.ts` in this service
 * is a `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the two
 * builders below. Everything except the operation and the IAM action list
 * is boilerplate: channel-scoped bindings inject the bound channel's ARN
 * as the request's `channelArn` and grant `actions` on that ARN;
 * account-scoped bindings pass the request through and grant `actions` on
 * `*`.
 */

/**
 * Build the impl Effect for an IVS operation scoped to a {@link Channel}:
 * the deploy-time half grants `actions` on the bound channel's ARN, and
 * the runtime half injects the channel's ARN into every request as
 * `channelArn`.
 */
export const makeIvsChannelHttpBinding = <
  I extends { channelArn: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.IVS.GetStream`. */
  tag: string;
  /** The distilled operation; `channelArn` is injected from the channel. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the channel ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (channel: Channel) {
      const ChannelArn = yield* channel.channelArn;
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
        request?: Omit<I, "channelArn">,
      ) {
        const channelArn = yield* ChannelArn;
        return yield* op({ ...request, channelArn } as I);
      });
    });
  });

/**
 * Build the impl Effect for an account-level IVS operation (e.g.
 * enumerating the account's live streams). The deploy-time half grants
 * `actions` on `*` — these list actions are not scoped to a single
 * channel resource.
 */
export const makeIvsAccountHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.IVS.ListStreams`. */
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
