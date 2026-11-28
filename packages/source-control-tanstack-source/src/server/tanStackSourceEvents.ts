import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import * as Credentials from "./TanStackSourceCredentials.ts";
import * as Hosts from "./tanStackSourceHosts.ts";

/** Source sends `: ok` every 15 seconds and ends each stream after 60. */
const SILENCE_LIMIT = Duration.seconds(45);
/** A stream that stayed open this long was healthy however it ended; Source closes at 60s. */
const HEALTHY_AFTER = Duration.seconds(30);
const MAX_FAILURES = 6;
const MAX_BACKOFF_MS = 60_000;
const NO_REDIRECT: RequestInit = { redirect: "manual" };

export interface PullRequestEventsInput {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
}

/**
 * Reads Source's stream a line at a time; true where a frame that reports a change ends. Source
 * also sends frames with an id alone, which only move the cursor, and `: ok` keep-alives; a
 * generic SSE decoder drops the former without recording their id.
 */
export function frameReader(cursor: { lastEventId: string | undefined }) {
  let reports = false;
  return (line: string): boolean => {
    if (line === "") {
      const ended = reports;
      reports = false;
      return ended;
    }
    if (line.startsWith(":")) return false;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /u, "");
    if (field === "id") cursor.lastEventId = value;
    else if (field === "event" || field === "data") reports = true;
    return false;
  };
}

/** How one connection ended: Source closes every stream after a minute, which is `reconnect`. */
type Ending = { readonly _tag: "reconnect"; readonly healthy: boolean } | { readonly _tag: "stop" };

/**
 * Follows the pull request's live event stream: once when it first connects, so a reader catches
 * up, then once per change Source reports. Reconnects resume from the last event, so nothing in
 * between is lost. Ends quietly when Source refuses it; readers then poll.
 */
export const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const credentials = yield* Credentials.TanStackSourceCredentials;

  const connection = (
    input: PullRequestEventsInput,
    cursor: { lastEventId: string | undefined },
  ): Stream.Stream<"changed" | Ending> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const credential = yield* credentials.get(input.host);
        const query = new URLSearchParams({ scope: "pr", number: String(input.number) });
        const response = yield* httpClient
          .execute(
            HttpClientRequest.get(
              `https://${input.host}/api/v1/repos/${input.repository}/events?${query}`,
            ).pipe(
              HttpClientRequest.setHeaders({
                accept: "text/event-stream",
                "user-agent": "t3code",
                authorization: `Bearer ${Redacted.value(credential.token)}`,
                ...(cursor.lastEventId === undefined
                  ? {}
                  : { "last-event-id": cursor.lastEventId }),
              }),
            ),
          )
          .pipe(
            Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
            Effect.provideService(FetchHttpClient.RequestInit, NO_REDIRECT),
          );
        if (response.status === 401 || response.status === 403 || response.status === 404)
          return Stream.succeed<Ending>({ _tag: "stop" });
        if (response.status !== 200)
          return Stream.succeed<Ending>({ _tag: "reconnect", healthy: false });
        const openedAt = yield* Clock.currentTimeMillis;
        // A stream with nothing to resume from is a catch-up point; one sent `Last-Event-ID`
        // resumes where the last left off, so it misses nothing and needs no refresh of its own.
        const opening = cursor.lastEventId === undefined ? (["changed"] as const) : [];
        const readLine = frameReader(cursor);
        let events = 0;
        return response.stream.pipe(
          Stream.timeoutOrElse({ duration: SILENCE_LIMIT, orElse: () => Stream.fail("silent") }),
          Stream.decodeText,
          Stream.splitLines,
          Stream.filter(readLine),
          Stream.map((): "changed" => {
            events += 1;
            return "changed";
          }),
          Stream.prepend(opening),
          Stream.concat(
            Stream.fromEffect(
              Clock.currentTimeMillis.pipe(
                Effect.map((closedAt): Ending => ({
                  _tag: "reconnect",
                  // An event, or a stream that ran most of its minute, proves it worked.
                  healthy: events > 0 || closedAt - openedAt >= Duration.toMillis(HEALTHY_AFTER),
                })),
              ),
            ),
          ),
        );
      }),
    ).pipe(
      Stream.catchCause((cause) =>
        Stream.fromEffect(
          Effect.logDebug("TanStack Source event stream failed", { cause }).pipe(
            Effect.as<Ending>({ _tag: "reconnect", healthy: false }),
          ),
        ),
      ),
    );

  const backoff = Effect.fn("TanStackSourceEvents.backoff")(function* (failures: number) {
    const jitter = yield* Random.next;
    yield* Effect.sleep(
      Duration.millis(Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** failures) * (0.5 + jitter / 2)),
    );
  });

  return (input: PullRequestEventsInput): Stream.Stream<void> => {
    const host = Hosts.tanStackSourceHost(input.host);
    const repository = Hosts.tanStackSourceRepositoryPath(input.repository);
    if (host === null || repository === null) return Stream.empty;
    const target = { host, repository, number: input.number };
    const cursor = { lastEventId: undefined as string | undefined };

    const follow = (failures: number): Stream.Stream<void> => {
      let ending: Ending = { _tag: "stop" };
      return connection(target, cursor).pipe(
        Stream.flatMap((element) => {
          if (element === "changed") return Stream.succeed(undefined);
          ending = element;
          return Stream.empty;
        }),
        Stream.concat(
          Stream.suspend(() => {
            if (ending._tag === "stop") return Stream.empty;
            const next = ending.healthy ? 0 : failures + 1;
            if (next > MAX_FAILURES) return Stream.empty;
            return next === 0
              ? follow(0)
              : Stream.fromEffectDrain(backoff(next)).pipe(Stream.concat(follow(next)));
          }),
        ),
      );
    };

    return follow(0);
  };
});
