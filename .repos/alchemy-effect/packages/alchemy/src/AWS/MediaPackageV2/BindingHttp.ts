import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Channel } from "./Channel.ts";
import type { ChannelGroup } from "./ChannelGroup.ts";
import type { OriginEndpoint } from "./OriginEndpoint.ts";

/**
 * Shared scaffolding for AWS Elemental MediaPackage v2 HTTP bindings.
 *
 * NOT exported from `index.ts` — every `{Op}Http.ts` in this service is a
 * thin `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the three
 * builders below. Everything except the operation and the IAM action list
 * is boilerplate: each builder injects the bound resource's identifying
 * names (`ChannelGroupName` / `ChannelName` / `OriginEndpointName`) into
 * every request and grants `actions` on the resource's ARN.
 *
 * Harvest-job operations authorize against the *harvest job* ARN, which is
 * the origin endpoint ARN with a `/harvestJob/{name}` suffix — set
 * `harvestJobScoped` to grant on that pattern instead of the endpoint ARN.
 */

/**
 * Build the impl Effect for a MediaPackage v2 operation scoped to a
 * {@link ChannelGroup}: the runtime callable injects the group's
 * `ChannelGroupName` and the deploy-time half grants `actions` on the
 * group ARN (plus everything beneath it — channels, endpoints, harvest
 * jobs — for list operations that enumerate child resources).
 */
export const makeMediaPackageV2ChannelGroupHttpBinding = <
  I extends { ChannelGroupName: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.MediaPackageV2.ListHarvestJobs`. */
  tag: string;
  /** The distilled operation; `ChannelGroupName` is injected from the group. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the group ARN and its child-resource pattern. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* <G extends ChannelGroup>(group: G) {
      const ChannelGroupName = yield* group.channelGroupName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${group}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [
                  Output.interpolate`${group.channelGroupArn}`,
                  Output.interpolate`${group.channelGroupArn}/*`,
                ],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${group.LogicalId})`)(function* (
        request?: Omit<I, "ChannelGroupName">,
      ) {
        return yield* op({
          ...request,
          ChannelGroupName: yield* ChannelGroupName,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for a MediaPackage v2 operation scoped to a
 * {@link Channel}: the runtime callable injects the channel's
 * `ChannelGroupName` + `ChannelName` and the deploy-time half grants
 * `actions` on the channel ARN.
 */
export const makeMediaPackageV2ChannelHttpBinding = <
  I extends { ChannelGroupName: string; ChannelName: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.MediaPackageV2.ResetChannelState`. */
  tag: string;
  /** The distilled operation; the channel's names are injected. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the channel ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* <C extends Channel>(channel: C) {
      const ChannelGroupName = yield* channel.channelGroupName;
      const ChannelName = yield* channel.channelName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${channel}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [Output.interpolate`${channel.channelArn}`],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${channel.LogicalId})`)(function* (
        request?: Omit<I, "ChannelGroupName" | "ChannelName">,
      ) {
        return yield* op({
          ...request,
          ChannelGroupName: yield* ChannelGroupName,
          ChannelName: yield* ChannelName,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for a MediaPackage v2 operation scoped to an
 * {@link OriginEndpoint}: the runtime callable injects the endpoint's
 * `ChannelGroupName` + `ChannelName` + `OriginEndpointName` and the
 * deploy-time half grants `actions` on the endpoint ARN — plus, when
 * `harvestJobScoped` is set, on the endpoint's harvest-job ARN pattern
 * (`{endpointArn}/harvestJob/*`) and the parent channel-group ARN:
 * MediaPackage authorizes `CreateHarvestJob` against the bare channel
 * group (observed live: "not authorized to perform
 * mediapackagev2:CreateHarvestJob on resource: arn:…:channelGroup/{g}").
 */
export const makeMediaPackageV2OriginEndpointHttpBinding = <
  I extends {
    ChannelGroupName: string;
    ChannelName: string;
    OriginEndpointName: string;
  },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.MediaPackageV2.CreateHarvestJob`. */
  tag: string;
  /** The distilled operation; the endpoint's names are injected. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the endpoint (or harvest-job pattern) ARN. */
  actions: readonly string[];
  /** Additionally grant on `{endpointArn}/harvestJob/*` (harvest-job ops). */
  harvestJobScoped?: boolean;
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* <O extends OriginEndpoint>(endpoint: O) {
      const ChannelGroupName = yield* endpoint.channelGroupName;
      const ChannelName = yield* endpoint.channelName;
      const OriginEndpointName = yield* endpoint.originEndpointName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${endpoint}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [
                  Output.interpolate`${endpoint.originEndpointArn}`,
                  ...(options.harvestJobScoped
                    ? [
                        Output.interpolate`${endpoint.originEndpointArn}/harvestJob/*`,
                        // The endpoint ARN is `…:channelGroup/{g}/channel/{c}/originEndpoint/{e}`;
                        // harvest-job actions authorize against the bare
                        // channel-group ARN prefix.
                        Output.map(
                          endpoint.originEndpointArn,
                          (arn): string => arn.split("/channel/")[0]!,
                        ),
                      ]
                    : []),
                ],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${endpoint.LogicalId})`)(function* (
        request?: Omit<
          I,
          "ChannelGroupName" | "ChannelName" | "OriginEndpointName"
        >,
      ) {
        return yield* op({
          ...request,
          ChannelGroupName: yield* ChannelGroupName,
          ChannelName: yield* ChannelName,
          OriginEndpointName: yield* OriginEndpointName,
        } as I);
      });
    });
  });
