import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as GitHubPullRequestEvents from "./gitHubPullRequestEvents.ts";
import { GitHubApiNotFoundError, GitHubApiResponseError } from "./GitHubRequestPolicy.ts";
import * as GitHubRest from "./GitHubRest.ts";

const target = { host: "github.com", repository: "pingdotgg/t3code", number: 15 };

const sse = (...frames: ReadonlyArray<readonly [string, string]>) =>
  frames.map(([event, data]) => `event: ${event}\ndata: ${data}\n\n`).join("");

function fakeRest(
  subscribe: (
    count: number,
  ) => Effect.Effect<string, GitHubApiResponseError | GitHubApiNotFoundError>,
  signedIn = true,
) {
  const posts: Array<unknown> = [];
  const deletes: Array<string> = [];
  const rest = GitHubRest.GitHubRest.of({
    rest: (input) =>
      input.method === "DELETE"
        ? Effect.sync(() => {
            deletes.push(input.path);
            return { status: 204, headers: {}, body: "", truncated: false, invalidUtf8: false };
          })
        : Effect.suspend(() => {
            posts.push(input.body);
            return subscribe(posts.length);
          }).pipe(
            Effect.map((body) => ({
              status: 201,
              headers: {},
              body,
              truncated: false,
              invalidUtf8: false,
            })),
          ),
    credential: (_host, options) =>
      Effect.succeed(
        options?.personal === true
          ? { token: Redacted.make("user-token"), fingerprint: "user", source: "gh" as const }
          : { token: Redacted.make("app-token"), fingerprint: "app", source: "app" as const },
      ),
    appCredential: () =>
      Effect.succeed(
        signedIn
          ? Option.some({
              token: Redacted.make("app-token"),
              fingerprint: "app",
              source: "app" as const,
            })
          : Option.none(),
      ),
  });
  return { rest, posts, deletes };
}

const eventsOf = (rest: GitHubRest.GitHubRest["Service"], httpClient: HttpClient.HttpClient) =>
  GitHubPullRequestEvents.make.pipe(
    Effect.provideService(GitHubRest.GitHubRest, rest),
    Effect.provideService(HttpClient.HttpClient, httpClient),
  );

const subscription = (id: number) =>
  Effect.succeed(
    JSON.stringify({ id, events_url: `https://api.github.com/event-subscriptions/${id}/events` }),
  );

it.effect("follows a pull request across a refused app token, reconnects, and renewals", () =>
  Effect.gen(function* () {
    const { rest, posts, deletes } = fakeRest(subscription);
    const connections: Array<string> = [];
    const answers = [
      // The app is not installed on this repository; the user's own token reads it.
      () => new Response(null, { status: 404 }),
      () =>
        new Response(
          sse(
            ["com.github.pull_request.head.changed.v1", "{}"],
            ["github.stream.end", '{"outcome":"reconnect","reason":"shutdown"}'],
          ),
        ),
      () =>
        new Response(
          sse(["github.stream.end", '{"outcome":"subscription_ended","reason":"expired"}']),
        ),
      () => new Response(": heartbeat\n\n"),
    ];
    const httpClient = HttpClient.make((request) =>
      Effect.sync(() => {
        connections.push(`${request.url} ${request.headers.authorization}`);
        return HttpClientResponse.fromWeb(request, answers[connections.length - 1]!());
      }),
    );

    const events = yield* eventsOf(rest, httpClient);
    const fiber = yield* events(target).pipe(Stream.take(4), Stream.runCount, Effect.forkChild);
    yield* TestClock.adjust("5 minutes");
    // An open per connection plus the head change.
    assert.equal(yield* Fiber.join(fiber), 4);

    assert.deepEqual(connections, [
      "https://api.github.com/event-subscriptions/1/events Bearer app-token",
      "https://api.github.com/event-subscriptions/1/events Bearer user-token",
      "https://api.github.com/event-subscriptions/1/events Bearer user-token",
      "https://api.github.com/event-subscriptions/2/events Bearer app-token",
    ]);
    assert.deepEqual(posts[0], {
      resource_url: "https://github.com/pingdotgg/t3code/pull/15",
      event_types: [
        "com.github.pull_request.review.submitted.v1",
        "com.github.pull_request.head.changed.v1",
        "com.github.pull_request.state.changed.v1",
        "com.github.pull_request.merge_conflict.v1",
      ],
    });
    assert.deepEqual(deletes, ["event-subscriptions/1", "event-subscriptions/2"]);
  }),
);

it.effect("gives up on a silent stream and deletes its subscription", () =>
  Effect.gen(function* () {
    const { rest, posts, deletes } = fakeRest(subscription);
    let connections = 0;
    // Answers, then never sends a byte, not even a keep-alive.
    const httpClient = HttpClient.make((request) =>
      Effect.sync(() => {
        connections += 1;
        return HttpClientResponse.fromWeb(request, new Response(new ReadableStream()));
      }),
    );
    const events = yield* eventsOf(rest, httpClient);
    const fiber = yield* events(target).pipe(Stream.runCount, Effect.forkChild);
    yield* TestClock.adjust("15 minutes");

    assert.equal(yield* Fiber.join(fiber), 7, "one catch-up read per connection");
    assert.equal(connections, 7);
    assert.equal(posts.length, 1);
    assert.deepEqual(deletes, ["event-subscriptions/1"]);
  }),
);

it.effect("leaves users without the app sign-in, other hosts, and refusals to polling", () =>
  Effect.gen(function* () {
    const httpClient = HttpClient.make(() => Effect.die("no stream without a subscription"));
    const signedOut = fakeRest(subscription, false);
    assert.equal(yield* Stream.runCount((yield* eventsOf(signedOut.rest, httpClient))(target)), 0);
    assert.equal(signedOut.posts.length, 0);

    const signedIn = fakeRest(subscription);
    const enterprise = { ...target, host: "ghe.example.com" };
    assert.equal(
      yield* Stream.runCount((yield* eventsOf(signedIn.rest, httpClient))(enterprise)),
      0,
    );
    assert.equal(signedIn.posts.length, 0);

    const refused = fakeRest(() =>
      Effect.fail(
        new GitHubApiResponseError({
          host: "github.com",
          operation: "subscribePullRequestEvents",
          status: 403,
        }),
      ),
    );
    const events = yield* eventsOf(refused.rest, httpClient);
    assert.equal(yield* Stream.runCount(events(target)), 0);
    assert.equal(yield* Stream.runCount(events({ ...target, number: 16 })), 0);
    assert.equal(refused.posts.length, 1, "a refused account is not asked again for an hour");
    yield* TestClock.adjust("61 minutes");
    assert.equal(yield* Stream.runCount(events(target)), 0);
    assert.equal(refused.posts.length, 2);

    const missing = fakeRest(() =>
      Effect.fail(
        new GitHubApiNotFoundError({ host: "github.com", operation: "subscribePullRequestEvents" }),
      ),
    );
    const missingEvents = yield* eventsOf(missing.rest, httpClient);
    assert.equal(yield* Stream.runCount(missingEvents(target)), 0);
    assert.equal(yield* Stream.runCount(missingEvents(target)), 0);
    assert.equal(missing.posts.length, 1, "a pull request it cannot see is not asked again");
    assert.equal(yield* Stream.runCount(missingEvents({ ...target, number: 16 })), 0);
    assert.equal(missing.posts.length, 2, "other pull requests on the host still subscribe");
  }),
);
