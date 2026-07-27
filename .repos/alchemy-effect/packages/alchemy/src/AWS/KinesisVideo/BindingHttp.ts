import { Endpoint } from "@distilled.cloud/aws";
import * as kv from "@distilled.cloud/aws/kinesis-video";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { discoverDataEndpoint, discoverSignalingEndpoint } from "./internal.ts";
import type { SignalingChannel } from "./SignalingChannel.ts";
import type { Stream } from "./Stream.ts";

/**
 * Shared scaffolding for AWS Kinesis Video HTTP bindings.
 *
 * NOT exported from `index.ts` — every near-identical `{Op}Http.ts` in this
 * service is a thin `Layer.effect(Cap, make…HttpBinding({ … }))` over one of
 * the builders below. Kinesis Video data-plane calls are two-step: discover
 * the per-stream data endpoint (`GetDataEndpoint`) or per-channel signaling
 * endpoint (`GetSignalingChannelEndpoint`), then issue the signed data-plane
 * call against that endpoint. Everything except the operation, the endpoint
 * `APIName`/protocol, and the IAM action is boilerplate.
 */

/**
 * Build the impl Effect for a stream-scoped media/archived-media operation:
 * the runtime callable resolves the per-stream data endpoint for `apiName`
 * (cached), injects the bound {@link Stream}'s ARN as `StreamARN`, and the
 * deploy-time half grants `kinesisvideo:GetDataEndpoint` + `actions` on the
 * stream's ARN.
 */
export const makeStreamMediaHttpBinding = <
  I extends { StreamARN?: string; StreamName?: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.KinesisVideo.GetClip`. */
  tag: string;
  /** The `GetDataEndpoint` API name the operation is served under. */
  apiName: kv.APIName;
  /** IAM actions granted on the stream ARN (GetDataEndpoint is implied). */
  actions: readonly string[];
  /** The distilled operation; `StreamARN` is injected from the stream. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
}) =>
  Effect.gen(function* () {
    // Yield-first captures the operations' services (Credentials/Region/
    // HttpClient) at layer init so the runtime callable is requirement-free.
    const getDataEndpoint = yield* kv.getDataEndpoint;
    const op = yield* options.operation;

    return Effect.fn(function* (stream: Stream) {
      const StreamArn = yield* stream.streamArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${stream}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [
                  // the data plane requires per-stream endpoint discovery
                  "kinesisvideo:GetDataEndpoint",
                  ...options.actions,
                ],
                Resource: [stream.streamArn],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${stream.LogicalId})`)(function* (
        request?: Omit<I, "StreamARN" | "StreamName">,
      ) {
        const streamArn = yield* StreamArn;
        const endpoint = yield* discoverDataEndpoint(
          streamArn,
          options.apiName,
          getDataEndpoint,
        );
        return yield* op({ ...request, StreamARN: streamArn } as I).pipe(
          Effect.provideService(Endpoint.Endpoint, Effect.succeed(endpoint)),
        );
      });
    });
  });

/**
 * Build the impl Effect for a channel-scoped signaling/WebRTC-storage
 * operation: the runtime callable resolves the per-channel endpoint for
 * `protocol` + `role` (cached), injects the bound {@link SignalingChannel}'s
 * ARN under `key`, and the deploy-time half grants
 * `kinesisvideo:GetSignalingChannelEndpoint` + `actions` on the channel ARN.
 */
export const makeChannelSignalingHttpBinding = <
  K extends "ChannelARN" | "channelArn",
  I extends { [P in K]?: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.KinesisVideo.JoinStorageSession`. */
  tag: string;
  /** The signaling endpoint protocol the operation is served under. */
  protocol: kv.ChannelProtocol;
  /** The peer role the endpoint is resolved for. */
  role: kv.ChannelRole;
  /**
   * IAM actions granted on the channel ARN (GetSignalingChannelEndpoint is
   * implied).
   */
  actions: readonly string[];
  /** The request field the channel ARN is injected under. */
  key: K;
  /** The distilled operation; the channel ARN is injected under `key`. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
}) =>
  Effect.gen(function* () {
    // Yield-first captures the operations' services (Credentials/Region/
    // HttpClient) at layer init so the runtime callable is requirement-free.
    const getSignalingChannelEndpoint = yield* kv.getSignalingChannelEndpoint;
    const op = yield* options.operation;

    return Effect.fn(function* (channel: SignalingChannel) {
      const ChannelArn = yield* channel.channelArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${channel}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [
                  // the data plane requires per-channel endpoint discovery
                  "kinesisvideo:GetSignalingChannelEndpoint",
                  ...options.actions,
                ],
                Resource: [channel.channelArn],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${channel.LogicalId})`)(function* (
        request?: Omit<I, K>,
      ) {
        const channelArn = yield* ChannelArn;
        const endpoint = yield* discoverSignalingEndpoint(
          channelArn,
          options.protocol,
          options.role,
          getSignalingChannelEndpoint,
        );
        return yield* op({
          ...request,
          [options.key]: channelArn,
        } as I).pipe(
          Effect.provideService(Endpoint.Endpoint, Effect.succeed(endpoint)),
        );
      });
    });
  });
