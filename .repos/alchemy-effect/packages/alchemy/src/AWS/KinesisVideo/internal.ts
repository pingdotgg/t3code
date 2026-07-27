import * as kv from "@distilled.cloud/aws/kinesis-video";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * Raised when a Kinesis Video stream or signaling channel fails to reach
 * `ACTIVE` within the bounded polling budget after a create/update.
 */
export class KinesisVideoNotConverged extends Data.TaggedError(
  "KinesisVideoNotConverged",
)<{
  readonly resource: string;
  readonly status: string | undefined;
}> {}

/**
 * Raised when `GetSignalingChannelEndpoint` returns no endpoint for the
 * requested protocol.
 */
export class SignalingEndpointUnavailable extends Data.TaggedError(
  "SignalingEndpointUnavailable",
)<{
  readonly channelArn: string;
  readonly protocol: string;
}> {}

/**
 * Bounded retry through transient `ResourceInUseException` states — e.g.
 * deleting a stream or channel that is still `CREATING`/`UPDATING`, or
 * re-creating one whose previous incarnation is still `DELETING`.
 *
 * Expressed as an explicitly-typed module-scope helper: inlining
 * `Effect.retry` in lifecycle code leaves its conditional return type
 * unresolved in the provider's declaration emit, which widens the
 * `AWS.providers()` layer type for every downstream consumer.
 */
export const retryWhileResourceInUse = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "ResourceInUseException",
    schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(30)]),
  });

/**
 * Bounded retry through the transient states a mutation can hit while a
 * previous async transition settles: `ResourceInUseException` and the
 * synthetic `StreamNotActive` (Kinesis Video overloads
 * `ResourceNotFoundException` with "not found or not active" while a
 * stream/channel is CREATING/UPDATING — patched into a typed tag in
 * distilled). Explicitly typed for the declaration-emit reason above.
 */
export const retryWhileSettling = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) =>
      e._tag === "ResourceInUseException" || e._tag === "StreamNotActive",
    schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(15)]),
  });

/**
 * Bounded retry through `ResourceNotFoundException` — a freshly-created
 * stream/channel can be invisible to `Describe*` for a few seconds
 * (eventual consistency). Explicitly typed for the same declaration-emit
 * reason as above.
 */
export const retryWhileNotFound = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "ResourceNotFoundException",
    schedule: Schedule.max([Schedule.fixed("1 second"), Schedule.recurs(10)]),
  });

/**
 * Repeat a describe poll until `done` holds (bounded — streams and channels
 * typically become active within seconds). Explicitly typed for the
 * declaration-emit reason above.
 */
const untilConverged = <A, E, R>(
  self: Effect.Effect<A, E, R>,
  done: (a: A) => boolean,
): Effect.Effect<A, E, R> =>
  Effect.repeat(self, {
    schedule: Schedule.spaced("2 seconds"),
    until: done,
    times: 30,
  });

/**
 * Poll `DescribeStream` until the stream is `ACTIVE`. Tolerates the brief
 * post-create window where the stream is not yet describable.
 *
 * Mutations (`UpdateStream`/`UpdateDataRetention`) are asynchronous AND bump
 * the stream version — a describe issued immediately after can still show
 * the pre-mutation `ACTIVE` state with the stale version. Pass
 * `previousVersion` after a mutation to also wait for the version bump, so
 * the returned `Version` is safe to use in the next versioned call.
 */
export const waitForStreamActive = Effect.fn(
  "AWS.KinesisVideo.waitForStreamActive",
)(function* (streamName: string, previousVersion?: string) {
  const done = (info: kv.StreamInfo | undefined): boolean =>
    info?.Status === "ACTIVE" &&
    (previousVersion === undefined || info.Version !== previousVersion);
  const info = yield* untilConverged(
    retryWhileNotFound(kv.describeStream({ StreamName: streamName })).pipe(
      Effect.map((r) => r.StreamInfo),
    ),
    done,
  );
  if (!done(info)) {
    return yield* Effect.fail(
      new KinesisVideoNotConverged({
        resource: streamName,
        status: info?.Status,
      }),
    );
  }
  return info!;
});

/**
 * Poll `DescribeSignalingChannel` until the channel is `ACTIVE`. Tolerates
 * the brief post-create window where the channel is not yet describable.
 * Pass `previousVersion` after `UpdateSignalingChannel` to also wait for the
 * version bump (see {@link waitForStreamActive}).
 */
export const waitForChannelActive = Effect.fn(
  "AWS.KinesisVideo.waitForChannelActive",
)(function* (channelName: string, previousVersion?: string) {
  const done = (info: kv.ChannelInfo | undefined): boolean =>
    info?.ChannelStatus === "ACTIVE" &&
    (previousVersion === undefined || info.Version !== previousVersion);
  const info = yield* untilConverged(
    retryWhileNotFound(
      kv.describeSignalingChannel({ ChannelName: channelName }),
    ).pipe(Effect.map((r) => r.ChannelInfo)),
    done,
  );
  if (!done(info)) {
    return yield* Effect.fail(
      new KinesisVideoNotConverged({
        resource: channelName,
        status: info?.ChannelStatus,
      }),
    );
  }
  return info!;
});

/**
 * Poll `DescribeStream` until the stream is fully purged (NotFound).
 * A stream in `DELETING` blocks re-creation of the same name with
 * `ResourceInUseException`, so reconcilers wait it out before recreating.
 */
export const waitForStreamGone = Effect.fn(
  "AWS.KinesisVideo.waitForStreamGone",
)(function* (streamName: string) {
  const info = yield* untilConverged(
    kv.describeStream({ StreamName: streamName }).pipe(
      Effect.map((r) => r.StreamInfo),
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    ),
    (i) => i === undefined,
  );
  if (info !== undefined) {
    return yield* Effect.fail(
      new KinesisVideoNotConverged({
        resource: streamName,
        status: info.Status,
      }),
    );
  }
});

/**
 * Poll `DescribeSignalingChannel` until the channel is fully purged
 * (NotFound) — see {@link waitForStreamGone}.
 */
export const waitForChannelGone = Effect.fn(
  "AWS.KinesisVideo.waitForChannelGone",
)(function* (channelName: string) {
  const info = yield* untilConverged(
    kv.describeSignalingChannel({ ChannelName: channelName }).pipe(
      Effect.map((r) => r.ChannelInfo),
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    ),
    (i) => i === undefined,
  );
  if (info !== undefined) {
    return yield* Effect.fail(
      new KinesisVideoNotConverged({
        resource: channelName,
        status: info.ChannelStatus,
      }),
    );
  }
});

/**
 * Drop `undefined` values from a distilled tag map (`{ [key]: string |
 * undefined }`) so it can be diffed as a plain `Record<string, string>`.
 */
export const compactTags = (
  tags: { [key: string]: string | undefined } | undefined,
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags ?? {})) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
};

// Per-stream data endpoints are stable for the life of the stream — cache
// them per (arn, API) so repeated data-plane calls skip the extra
// GetDataEndpoint round-trip.
const dataEndpointCache = new Map<string, string>();

/**
 * Discover (and cache) the per-stream data endpoint for `apiName`.
 * Parameterized over the `GetDataEndpoint` operation so binding layers can
 * pass an operation captured via yield-first (`yield* op`) whose calls are
 * requirement-free.
 */
export const discoverDataEndpoint = <E, R>(
  streamArn: string,
  apiName: kv.APIName,
  getDataEndpoint: (
    input: kv.GetDataEndpointInput,
  ) => Effect.Effect<kv.GetDataEndpointOutput, E, R>,
): Effect.Effect<string, E, R> =>
  Effect.gen(function* () {
    const key = `${streamArn}#${apiName}`;
    const cached = dataEndpointCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const response = yield* getDataEndpoint({
      StreamARN: streamArn,
      APIName: apiName,
    });
    const url = response.DataEndpoint!;
    dataEndpointCache.set(key, url);
    return url;
  });

// Signaling endpoints are likewise stable per (channel, protocol, role).
const signalingEndpointCache = new Map<string, string>();

/**
 * Discover (and cache) the per-channel signaling endpoint for `protocol` +
 * `role` via `GetSignalingChannelEndpoint`. Parameterized over the operation
 * for the same yield-first reason as {@link discoverDataEndpoint}.
 */
export const discoverSignalingEndpoint = <E, R>(
  channelArn: string,
  protocol: kv.ChannelProtocol,
  role: kv.ChannelRole,
  getSignalingChannelEndpoint: (
    input: kv.GetSignalingChannelEndpointInput,
  ) => Effect.Effect<kv.GetSignalingChannelEndpointOutput, E, R>,
): Effect.Effect<string, E | SignalingEndpointUnavailable, R> =>
  Effect.gen(function* () {
    const key = `${channelArn}#${protocol}#${role}`;
    const cached = signalingEndpointCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const response = yield* getSignalingChannelEndpoint({
      ChannelARN: channelArn,
      SingleMasterChannelEndpointConfiguration: {
        Protocols: [protocol],
        Role: role,
      },
    });
    const endpoint = (response.ResourceEndpointList ?? []).find(
      (item) => item.Protocol === protocol,
    )?.ResourceEndpoint;
    if (endpoint === undefined) {
      return yield* Effect.fail(
        new SignalingEndpointUnavailable({ channelArn, protocol }),
      );
    }
    signalingEndpointCache.set(key, endpoint);
    return endpoint;
  });
