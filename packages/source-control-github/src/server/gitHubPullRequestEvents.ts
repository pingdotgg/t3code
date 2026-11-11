import { normalizeHost } from "@t3tools/source-control-core/server/pullRequestUtils";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Sse from "effect/encoding/Sse";
import { HttpClient, HttpClientRequest } from "effect/http";

import * as GitHubRest from "./GitHubRest.ts";

/** Events only say that something changed; readers fetch the pull request for what. */
const EVENT_TYPES = [
  "com.github.pull_request.review.submitted.v1",
  "com.github.pull_request.head.changed.v1",
  "com.github.pull_request.state.changed.v1",
  "com.github.pull_request.merge_conflict.v1",
];
const API_ORIGIN = "https://api.github.com";
/** GitHub sends a keep-alive at least every 15 seconds while a stream is idle. */
const SILENCE_LIMIT = Duration.seconds(45);
/** A connection open this long was healthy, however it ended. */
const HEALTHY_AFTER = Duration.minutes(2);
/** GitHub enables event streams per account, so a refusal holds for a while. */
const REFUSED_PAUSE = Duration.hours(1);
/** Another watch ending may free a slot under the per-account subscription limit. */
const LIMIT_PAUSE = Duration.minutes(10);
const MAX_FAILURES = 6;
const MAX_BACKOFF_MS = 60_000;

const Subscription = Schema.Struct({
  id: Schema.Union([Schema.String, Schema.Number]),
  events_url: Schema.String,
});
const decodeSubscription = Schema.decodeUnknownOption(Schema.fromJsonString(Subscription));

const decodeStreamEnd = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ outcome: Schema.String })),
);

/**
 * How a connection ended. `renew` means the subscription expired or lost access, and `personal`
 * that the app's token was refused where the user's own may still read.
 */
type Ending = "reconnect" | "renew" | "personal" | "stop";

const endingOf = (data: string): Ending =>
  Option.match(decodeStreamEnd(data), {
    onNone: () => "reconnect",
    onSome: ({ outcome }) => (outcome === "subscription_ended" ? "renew" : "reconnect"),
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
export const make = Effect.gen(function* () {
  const rest = yield* GitHubRest.GitHubRest;
  const httpClient = yield* HttpClient.HttpClient;
  /** Keyed by host for account-wide refusals, and by pull request for one it cannot read. */
  const pausedUntil = new Map<string, number>();

  const subscribe = Effect.fn("GitHubPullRequestEvents.subscribe")(function* (
    input: PullRequestEventsInput,
  ) {
    const resourceUrl = `https://${input.host}/${input.repository}/pull/${input.number}`;
    const now = yield* Clock.currentTimeMillis;
    if (Math.max(pausedUntil.get(input.host) ?? 0, pausedUntil.get(resourceUrl) ?? 0) > now) {
      return Option.none();
    }
    const pause = (key: string, duration: Duration.Duration) =>
      Effect.sync(() => pausedUntil.set(key, now + Duration.toMillis(duration)));
    const response = yield* rest
      .rest({
        host: input.host,
        operation: "subscribePullRequestEvents",
        method: "POST",
        path: "event-subscriptions",
        body: { resource_url: resourceUrl, event_types: EVENT_TYPES },
      })
      .pipe(
        Effect.asSome,
        Effect.catchTags({
          GitHubApiNotFoundError: () =>
            pause(resourceUrl, REFUSED_PAUSE).pipe(Effect.as(Option.none())),
          GitHubApiResponseError: (error) =>
            (error.status === 403
              ? pause(input.host, REFUSED_PAUSE)
              : error.status === 422
                ? pause(input.host, LIMIT_PAUSE)
                : Effect.void
            ).pipe(Effect.as(Option.none())),
        }),
        Effect.catch((error) =>
          Effect.logDebug("pull request event subscription failed", { error }).pipe(
            Effect.as(Option.none()),
          ),
        ),
      );
    if (Option.isNone(response)) return Option.none();
    // The stream request carries the token, so its URL must stay on GitHub's API.
    return decodeSubscription(response.value.body).pipe(
      Option.filter(({ events_url }) => URL.parse(events_url)?.origin === API_ORIGIN),
    );
  });

  const unsubscribe = Effect.fn("GitHubPullRequestEvents.unsubscribe")(function* (
    host: string,
    id: string | number,
  ) {
    yield* rest
      .rest({
        host,
        operation: "unsubscribePullRequestEvents",
        method: "DELETE",
        path: `event-subscriptions/${encodeURIComponent(String(id))}`,
      })
      .pipe(Effect.ignore);
  });

  /** One SSE connection: "changed" when it opens and per event, and last, how it ended. */
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
        if (response.status !== 200) return Stream.succeed<Ending>("reconnect");
        return response.stream.pipe(
          Stream.timeoutOrElse({ duration: SILENCE_LIMIT, orElse: () => Stream.fail("silent") }),
          Stream.decodeText,
          Stream.pipeThroughChannel(Sse.decode()),
          Stream.map((frame): "changed" | Ending =>
            frame.event === "github.stream.end" ? endingOf(frame.data) : "changed",
          ),
          Stream.prepend(["changed" as const]),
          // A close without GitHub's end frame is reconnected like one with it.
          Stream.concat(Stream.succeed<Ending>("reconnect")),
          Stream.takeUntil((element) => element !== "changed"),
        );
      }),
    ).pipe(
      Stream.catchCause((cause) =>
        Stream.fromEffect(
          Effect.logDebug("pull request event stream failed", { cause }).pipe(
            Effect.as<Ending>("reconnect"),
          ),
        ),
      ),
    );

  const backoff = Effect.fn("GitHubPullRequestEvents.backoff")(function* (failures: number) {
    const jitter = yield* Random.next;
    yield* Effect.sleep(
      Duration.millis(Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** failures) * (0.5 + jitter / 2)),
    );
  });

  return (input: PullRequestEventsInput): Stream.Stream<void> => {
    const target = { ...input, host: normalizeHost(input.host) };
    if (target.host !== "github.com") return Stream.empty;

    /** Follows one subscription; sets `session.renew` when it needs replacing. */
    const follow = (
      session: { renew: boolean },
      eventsUrl: string,
      personal: boolean,
      failuresSoFar: number,
    ): Stream.Stream<void> =>
      Stream.unwrap(
        Clock.currentTimeMillis.pipe(
          Effect.map((openedAt) => {
            let ending: Ending = "reconnect";
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
                Stream.unwrap(
                  Clock.currentTimeMillis.pipe(
                    Effect.map((closedAt) => {
                      // The first change is the opening; an event or a long life proves it worked.
                      const healthy =
                        changes > 1 || closedAt - openedAt >= Duration.toMillis(HEALTHY_AFTER);
                      const failures = healthy ? 0 : failuresSoFar + 1;
                      switch (ending) {
                        case "stop":
                          return Stream.empty;
                        case "renew":
                          session.renew = true;
                          return Stream.empty;
                        case "personal":
                          return personal
                            ? Stream.empty
                            : follow(session, eventsUrl, true, failuresSoFar);
                        case "reconnect":
                          return failures > MAX_FAILURES
                            ? Stream.empty
                            : Stream.fromEffectDrain(backoff(failures)).pipe(
                                Stream.concat(follow(session, eventsUrl, personal, failures)),
                              );
                      }
                    }),
                  ),
                ),
              ),
            );
          }),
        ),
      );

    /** One subscription, deleted once its stream has closed. */
    const subscription = (session: { renew: boolean }): Stream.Stream<void> =>
      Stream.unwrap(
        Effect.acquireRelease(subscribe(target), (held) =>
          Option.isSome(held) ? unsubscribe(target.host, held.value.id) : Effect.void,
        ).pipe(
          Effect.map(
            Option.match({
              onNone: () => Stream.empty,
              onSome: ({ events_url }) => follow(session, events_url, false, 0),
            }),
          ),
        ),
      );

    const subscribed = (): Stream.Stream<void> =>
      Stream.suspend(() => {
        const session = { renew: false };
        return subscription(session).pipe(
          Stream.concat(
            Stream.suspend(() =>
              session.renew
                ? Stream.fromEffectDrain(backoff(0)).pipe(Stream.concat(subscribed()))
                : Stream.empty,
            ),
          ),
        );
      });

    // Event streams are a GitHub preview, so only the app sign-in, itself opt-in, uses them.
    return Stream.unwrap(
      rest.appCredential(target.host).pipe(
        Effect.map((app) => (Option.isSome(app) ? subscribed() : Stream.empty)),
        Effect.orElseSucceed(() => Stream.empty),
      ),
    );
  };
});
