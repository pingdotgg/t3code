import { normalizeHost } from "@t3tools/source-control-core/server/pullRequestUtils";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Sse from "effect/encoding/Sse";
import { HttpClient, HttpClientRequest } from "effect/http";

import type * as GitHubRest from "./GitHubRest.ts";

/** Events only say that something changed; readers fetch the pull request for what. */
const EVENT_TYPES = [
  "com.github.pull_request.review.submitted.v1",
  "com.github.pull_request.head.changed.v1",
  "com.github.pull_request.state.changed.v1",
  "com.github.pull_request.merge_conflict.v1",
];
const API_ORIGIN = "https://api.github.com";
/** GitHub sends a heartbeat at least every 15 seconds while a stream is idle. */
const SILENCE_LIMIT = Duration.seconds(45);
const MAX_DROPS = 6;
const MAX_BACKOFF_MS = 60_000;

const Subscription = Schema.Struct({
  id: Schema.Union([Schema.String, Schema.Number]),
  events_url: Schema.String,
});
const decodeSubscription = Schema.decodeUnknownOption(Schema.fromJsonString(Subscription));

const Outcome = Schema.Struct({ outcome: Schema.optional(Schema.String) });
const decodeStreamEnd = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Union([Schema.Struct({ data: Outcome }), Outcome])),
);

/**
 * How a connection ended. `reconnect` is GitHub closing it on purpose and `dropped` is anything
 * else; `renew` means the subscription itself expired, and `personal` that the app's token was
 * refused where the user's own may still read.
 */
type Ending = "reconnect" | "dropped" | "renew" | "personal" | "stop";

const endingOf = (data: string): Ending =>
  Option.match(decodeStreamEnd(data), {
    onNone: () => "reconnect",
    onSome: (end) =>
      ("data" in end ? end.data.outcome : end.outcome) === "subscription_ended"
        ? "renew"
        : "reconnect",
  });

export interface PullRequestEventsInput {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
}

/**
 * Emits when a connection opens, so a reader catches up on what it missed, then once per change
 * GitHub reports. Ends quietly when GitHub refuses the subscription; the caller polls meanwhile.
 */
export const make = (rest: GitHubRest.GitHubRest["Service"], httpClient: HttpClient.HttpClient) => {
  const subscribe = Effect.fn("GitHubPullRequestEvents.subscribe")(function* (
    input: PullRequestEventsInput,
  ) {
    const response = yield* rest
      .rest({
        host: input.host,
        operation: "subscribePullRequestEvents",
        method: "POST",
        path: "event-subscriptions",
        body: {
          resource_url: `https://${input.host}/${input.repository}/pull/${input.number}`,
          event_types: EVENT_TYPES,
        },
      })
      .pipe(
        Effect.asSome,
        // Past the per-user subscription limit too; the next sweep asks again.
        Effect.catch((error) =>
          Effect.logDebug("pull request event subscription failed", { error }).pipe(
            Effect.as(Option.none()),
          ),
        ),
      );
    if (Option.isNone(response)) return Option.none();
    // The stream URL carries the token, so it must stay on GitHub's API.
    return decodeSubscription(response.value.body).pipe(
      Option.filter(({ events_url }) => URL.parse(events_url)?.origin === API_ORIGIN),
    );
  });

  const unsubscribe = (host: string, id: string | number) =>
    rest
      .rest({
        host,
        operation: "unsubscribePullRequestEvents",
        method: "DELETE",
        path: `event-subscriptions/${encodeURIComponent(String(id))}`,
      })
      .pipe(Effect.ignore);

  /** One SSE connection: "changed" per event, and last, how it ended. */
  const connection = (
    host: string,
    eventsUrl: string,
    personal: boolean,
  ): Stream.Stream<"changed" | Ending> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const held = yield* rest.credential(host, { personal });
        const response = yield* httpClient
          .execute(
            HttpClientRequest.get(eventsUrl).pipe(
              HttpClientRequest.setHeaders({
                accept: "text/event-stream",
                "x-github-api-version": "2022-11-28",
                "user-agent": "t3code",
                authorization: `Bearer ${Redacted.value(held.token)}`,
              }),
            ),
          )
          // Client spans would carry the subscription URL.
          .pipe(Effect.provideService(HttpClient.TracerDisabledWhen, () => true));
        if (response.status === 403 || response.status === 404) {
          return Stream.succeed<Ending>(held.source === "app" ? "personal" : "stop");
        }
        if (response.status !== 200) return Stream.succeed<Ending>("dropped");
        return response.stream.pipe(
          Stream.timeoutOrElse({ duration: SILENCE_LIMIT, orElse: () => Stream.fail("silent") }),
          Stream.decodeText,
          Stream.pipeThroughChannel(Sse.decode()),
          Stream.map((frame): "changed" | Ending =>
            frame.event === "github.stream.end" ? endingOf(frame.data) : "changed",
          ),
          Stream.prepend(["changed" as const]),
          Stream.concat(Stream.succeed<Ending>("dropped")),
          Stream.takeUntil((element) => element !== "changed"),
        );
      }),
    ).pipe(Stream.catchCause(() => Stream.succeed<Ending>("dropped")));

  const backoff = (drops: number) =>
    Random.next.pipe(
      Effect.flatMap((jitter) =>
        Effect.sleep(
          Duration.millis(Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** drops) * (0.5 + jitter / 2)),
        ),
      ),
    );

  return (input: PullRequestEventsInput): Stream.Stream<void> => {
    const target = { ...input, host: normalizeHost(input.host) };
    if (target.host !== "github.com") return Stream.empty;

    /** Follows one subscription; sets `session.renew` when it expired and needs replacing. */
    const follow = (
      session: { renew: boolean },
      eventsUrl: string,
      personal: boolean,
      dropsSoFar: number,
    ): Stream.Stream<void> =>
      Stream.suspend(() => {
        let drops = dropsSoFar;
        let ending: Ending = "dropped";
        let changes = 0;
        return connection(target.host, eventsUrl, personal).pipe(
          Stream.flatMap((element) => {
            if (element === "changed") {
              changes += 1;
              return Stream.succeed(undefined);
            }
            ending = element;
            return Stream.empty;
          }),
          Stream.concat(
            Stream.suspend(() => {
              // The first change is the connection opening; anything after proves it worked.
              if (changes > 1) drops = 0;
              switch (ending) {
                case "stop":
                  return Stream.empty;
                case "renew":
                  session.renew = true;
                  return Stream.empty;
                case "personal":
                  return personal ? Stream.empty : follow(session, eventsUrl, true, drops);
                case "reconnect":
                  return Stream.fromEffectDrain(backoff(0)).pipe(
                    Stream.concat(follow(session, eventsUrl, personal, 0)),
                  );
                case "dropped":
                  return drops >= MAX_DROPS
                    ? Stream.empty
                    : Stream.fromEffectDrain(backoff(drops + 1)).pipe(
                        Stream.concat(follow(session, eventsUrl, personal, drops + 1)),
                      );
              }
            }),
          ),
        );
      });

    const subscribed = (): Stream.Stream<void> =>
      Stream.unwrap(
        subscribe(target).pipe(
          Effect.map(
            Option.match({
              onNone: () => Stream.empty,
              onSome: (subscription) => {
                const session = { renew: false };
                return follow(session, subscription.events_url, false, 0).pipe(
                  // GitHub keeps a deleted subscription's open streams, so close the stream first.
                  Stream.ensuring(unsubscribe(target.host, subscription.id)),
                  Stream.concat(
                    Stream.suspend(() =>
                      session.renew
                        ? Stream.fromEffectDrain(backoff(0)).pipe(Stream.concat(subscribed()))
                        : Stream.empty,
                    ),
                  ),
                );
              },
            }),
          ),
        ),
      );

    // Event streams are a GitHub preview, so only the app sign-in, itself opt-in, uses them.
    return Stream.unwrap(
      rest.appCredential(target.host).pipe(
        Effect.map((app) => (Option.isSome(app) ? subscribed() : Stream.empty)),
        Effect.orElseSucceed(() => Stream.empty),
      ),
    );
  };
};
