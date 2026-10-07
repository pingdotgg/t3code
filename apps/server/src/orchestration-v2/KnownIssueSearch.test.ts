import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/http";

import * as KnownIssueSearch from "./KnownIssueSearch.ts";

const REPO_SUFFIX = "repo:pingdotgg/t3code is:issue";

const PRIVATE_WORDS = [
  "correcthorse",
  "buildhost",
  "acquisition",
  "plans",
  "billing",
  "migration",
  "internal",
  "hunter2",
  "alex",
  "example",
];

const categoryTerms = KnownIssueSearch.KNOWN_ISSUE_CATEGORIES.map((category) => category.term);

describe("buildKnownIssueQuery", () => {
  it("names the kinds of failure it matched and nothing the message said", () => {
    const query = KnownIssueSearch.buildKnownIssueQuery({
      message:
        "The provider could not start this turn: Failed to read attachment '3f2b8c1e-aaaa-4bbb-8ccc-0123456789ab'. Retry the turn; if it keeps failing, check the provider setup and server logs.",
      driver: "codex",
    });
    assert.equal(query, `attachment read turn start codex ${REPO_SUFFIX}`);
  });

  // Each of these once sent words of a private name, because punctuation was dropped before matching.
  it.each([
    ["Failed to read repo billing-migration: permission denied", "permission denied codex"],
    ["Connection refused by auth.billing.internal", "connection refused codex"],
    ["Failed to authenticate token : correcthorse", null],
    ["Invalid API_KEY: correcthorse", null],
    ["Connection refused by buildhost while reading the stream", "connection refused codex"],
    ["Failed to read repo acquisition-plans: permission denied", "permission denied codex"],
    ["Failed to read /Users/alex/.env: permission denied", "permission denied codex"],
    [
      "Failed to reach https://api.example.com/v1?key=hunter2 connection reset",
      "connection reset codex",
    ],
  ])("sends only fixed category terms for %j", (message, expected) => {
    const query = KnownIssueSearch.buildKnownIssueQuery({ message, driver: "codex" });
    assert.equal(query, expected === null ? null : `${expected} ${REPO_SUFFIX}`);
    for (const word of PRIVATE_WORDS) assert.notInclude(query ?? "", word);
  });

  it("does not build a phrase out of dotted or hyphenated names", () => {
    for (const message of [
      "auth.billing.internal rejected it",
      "billing-migration: permission-denied",
      "see not.installed and timed-out and rate.limit",
      "xpermission denied",
      "permission deniedx",
    ]) {
      assert.isNull(KnownIssueSearch.buildKnownIssueQuery({ message, driver: "codex" }), message);
    }
  });

  it("still matches a phrase that ends a sentence", () => {
    assert.equal(
      KnownIssueSearch.buildKnownIssueQuery({
        message: "Request failed: permission denied.",
        driver: null,
      }),
      `permission denied ${REPO_SUFFIX}`,
    );
  });

  it("keeps at most three categories, in priority order", () => {
    const query = KnownIssueSearch.buildKnownIssueQuery({
      message: "timed out: permission denied, rate limit hit, connection refused, sandbox",
      driver: null,
    });
    assert.equal(query, `rate limit permission denied timeout ${REPO_SUFFIX}`);
  });

  it("searches nothing when no category matches", () => {
    assert.isNull(
      KnownIssueSearch.buildKnownIssueQuery({
        message: "Failed. '/Users/alex/x' 12345 3f2b8c1e-aaaa-4bbb-8ccc-0123456789ab",
        driver: "codex",
      }),
    );
  });

  // The failures T3 itself writes, and common provider errors.
  it.each([
    ["Failed to read attachment 'a-b'", "attachment read"],
    ["Claude provider turn provider-turn:abc is still active.", "turn still active"],
    ["Cursor provider turn x is still active.", "turn still active"],
    [
      "The provider could not start this turn. Retry the turn; if it keeps failing, check the provider setup and server logs.",
      "turn start",
    ],
    ["Claude could not start the turn.", "turn start"],
    ["Provider turn failed to start", "turn start"],
    [
      "The provider session could not be opened. Check that the provider is installed and signed in, then retry the turn.",
      "session open",
    ],
    ["Provider session failed to open", "session open"],
    [
      "The provider conversation could not be resumed. Retry the turn; if it keeps failing, check the provider and server logs.",
      "resume",
    ],
    [
      "The provider event stream closed unexpectedly. Retry the turn; if it keeps failing, check the provider and server logs.",
      "event stream closed",
    ],
    ["The OpenCode event stream was lost and could not reconnect.", "event stream closed"],
    [
      "The provider could not roll back this conversation. Try again; if it keeps failing, check the provider and server logs.",
      "rollback",
    ],
    [
      "Insufficient context allowance for the provider handoff. Compact the target conversation or use a larger-context model.",
      "context handoff",
    ],
    ["Claude stopped: an image in the conversation could not be processed.", "image processing"],
    [
      "Claude could not authenticate. For subscription login, run `claude auth login`.",
      "authentication",
    ],
    ["401 Unauthorized", "authentication"],
    ["You have hit your usage limit", "usage limit"],
    ["429 Too Many Requests", "rate limit"],
    ["spawn codex ENOENT", "not installed"],
    ["zsh: command not found: codex", "not installed"],
    ["Request timed out", "timeout"],
    ["The operation timed out.", "timeout"],
    ["connect ECONNREFUSED 127.0.0.1:4096", "connection refused"],
    ["read ECONNRESET", "connection reset"],
    ["The prompt is too long for the context window", "context window"],
    [
      "Claude is still running background agents or commands, and this model or setting change would end them.",
      "background work",
    ],
    ["Claude could not resume a deferred tool call: the tool is no longer available.", "resume"],
    ["JavaScript heap out of memory", "out of memory"],
    ["write failed: no space left on device", "no space left"],
  ])("recognizes %j as %s", (message, term) => {
    assert.include(KnownIssueSearch.categoryTermsForFailure(message), term);
  });

  it("emits only category terms, the repository qualifiers, and fixed driver keywords, whatever the input", () => {
    const drivers = [
      null,
      "claudeAgent",
      "codex",
      "cursor",
      "opencode",
      "grok",
      "pi",
      "antigravity",
      "acpRegistry",
      "my-private-driver",
    ];
    const messages = [
      "Invalid API_KEY: correcthorse",
      "Failed to read repo billing-migration: permission denied, timed out, rate limit, connection refused, sandbox, mcp",
      "Connection refused by auth.billing.internal",
      "The provider session could not be opened. Check that the provider is installed and signed in, then retry the turn.",
      "Ünïcode 😀 failed to read attachment in /home/me/acquisition-plans permission denied",
    ];
    const allowed = new Set([
      ...categoryTerms.flatMap((term) => term.split(" ")),
      "claude",
      "codex",
      "cursor",
      "opencode",
      "grok",
      "pi",
      "antigravity",
      "acp",
    ]);
    for (const message of messages) {
      for (const driver of drivers) {
        const query = KnownIssueSearch.buildKnownIssueQuery({ message, driver });
        if (query === null) continue;
        assert.isTrue(query.endsWith(` ${REPO_SUFFIX}`));
        for (const word of query.slice(0, -REPO_SUFFIX.length - 1).split(" ")) {
          assert.isTrue(allowed.has(word), `${word} is not allowed`);
        }
      }
    }
  });

  it("maps drivers to a fixed keyword and ignores any other", () => {
    assert.equal(KnownIssueSearch.driverKeyword("claudeAgent"), "claude");
    assert.equal(KnownIssueSearch.driverKeyword("acpRegistry"), "acp");
    assert.equal(KnownIssueSearch.driverKeyword("pi"), "pi");
    assert.isNull(KnownIssueSearch.driverKeyword("pickle"));
    assert.isNull(KnownIssueSearch.driverKeyword("my-private-driver"));
    assert.isNull(KnownIssueSearch.driverKeyword(null));
  });
});

describe("selectKnownIssue", () => {
  const candidates = [
    { number: 12, title: "Thread hangs", state: "open", url: "https://github.com/x/y/issues/12" },
    { number: 40, title: "Crash", state: "closed", url: "https://github.com/x/y/issues/40" },
  ];

  it("returns the named candidate", () => {
    assert.equal(KnownIssueSearch.selectKnownIssue(candidates, 40)?.title, "Crash");
  });

  it("ignores a number that is not a candidate", () => {
    assert.isNull(KnownIssueSearch.selectKnownIssue(candidates, 99));
    assert.isNull(KnownIssueSearch.selectKnownIssue(candidates, null));
    assert.isNull(KnownIssueSearch.selectKnownIssue([], 12));
  });
});

const makeSearch = (
  respond: (request: HttpClientRequest.HttpClientRequest) => Response | Error,
  options: { readonly delay?: Duration.Input } = {},
) => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const layer = KnownIssueSearch.layerWithHttpClient.pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          requests.push(request);
          const answer = respond(request);
          const reply =
            answer instanceof Error
              ? Effect.die(answer)
              : Effect.succeed(HttpClientResponse.fromWeb(request, answer));
          // The clock moves while the answer is on its way.
          return options.delay === undefined
            ? reply
            : Effect.sleep(options.delay).pipe(Effect.andThen(reply));
        }),
      ),
    ),
  );
  /** One service for all the searches in `use`, so its backoff and cache carry across them. */
  const run = <A, E>(
    use: (
      search: (
        message?: string,
      ) => Effect.Effect<ReadonlyArray<KnownIssueSearch.KnownIssueCandidate>>,
    ) => Effect.Effect<A, E>,
  ) =>
    Effect.gen(function* () {
      const service = yield* KnownIssueSearch.KnownIssueSearch;
      return yield* use((message = MESSAGE) => service.search({ message, driver: "codex" }));
    }).pipe(Effect.provide(layer));
  return { requests, run };
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const MESSAGE = "Failed to read attachment";
const QUERY = `attachment read codex ${REPO_SUFFIX}`;
const OTHER_MESSAGE = "Request timed out";
const oneIssue = (title = "Attachment read fails") =>
  json({ items: [{ number: 7, title, state: "open", html_url: "https://evil.example/x" }] });

describe("KnownIssueSearch", () => {
  it.effect("asks GitHub for the repository's issues and returns clean candidates", () =>
    Effect.gen(function* () {
      const { requests, run } = makeSearch(() => oneIssue("  Attachment\nread   fails "));
      const candidates = yield* run((search) => search());

      assert.deepEqual(candidates, [
        {
          number: 7,
          title: "Attachment read fails",
          state: "open",
          url: "https://github.com/pingdotgg/t3code/issues/7",
        },
      ]);
      const request = requests[0]!;
      assert.equal(request.url, "https://api.github.com/search/issues");
      assert.deepEqual(request.urlParams.params, [
        ["q", QUERY],
        ["per_page", "5"],
      ]);
      assert.equal(request.headers["accept"], "application/vnd.github+json");
      assert.isString(request.headers["user-agent"]);
      assert.isUndefined(request.headers["authorization"]);
    }),
  );

  it.effect("cuts a long candidate title on a code point boundary", () =>
    Effect.gen(function* () {
      // The cut at 117 units would fall between the halves of the emoji.
      const { run } = makeSearch(() => oneIssue(`${"a".repeat(116)}😀 tail`));
      const [candidate] = yield* run((search) => search());
      assert.isTrue(candidate!.title.isWellFormed());
      assert.isTrue(candidate!.title.endsWith("..."));
      assert.isAtMost(candidate!.title.length, 120);
    }),
  );

  it.effect("returns no candidates when GitHub errors or answers oddly", () =>
    Effect.gen(function* () {
      for (const respond of [
        () => json({ message: "boom" }, 500),
        () => json({ items: "nope" }),
        () => new Response("<html>", { status: 200 }),
        () => new Error("connection reset"),
      ]) {
        assert.deepEqual(yield* makeSearch(respond).run((search) => search()), []);
      }
    }),
  );

  it.effect("skips the network when the failure has nothing to search for", () =>
    Effect.gen(function* () {
      const { requests, run } = makeSearch(() => new Error("unexpected request"));
      const result = yield* run((search) => search("Invalid API_KEY: correcthorse"));
      assert.deepEqual(result, []);
      assert.equal(requests.length, 0);
    }),
  );

  it.effect("stops searching until the rate limit resets", () =>
    Effect.gen(function* () {
      // GitHub names the reset as epoch seconds; the test clock starts at zero.
      let limited = true;
      const { requests, run } = makeSearch(() =>
        limited
          ? json({ message: "rate limit" }, 403, {
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": "30",
            })
          : oneIssue(),
      );
      yield* run((search) =>
        Effect.gen(function* () {
          assert.deepEqual(yield* search(), []);
          assert.equal(requests.length, 1);

          // Paused: no request, whatever the failure.
          yield* TestClock.adjust("29 seconds");
          limited = false;
          assert.deepEqual(yield* search(), []);
          assert.equal(requests.length, 1);

          yield* TestClock.adjust("2 seconds");
          assert.equal((yield* search()).length, 1);
          assert.equal(requests.length, 2);
        }),
      );
    }),
  );

  it.effect("pauses for a minute when GitHub gives no reset time, and honors retry-after", () =>
    Effect.gen(function* () {
      const noReset = makeSearch(() => json({ message: "slow down" }, 429));
      yield* noReset.run((search) =>
        Effect.gen(function* () {
          yield* search();
          yield* TestClock.adjust("59 seconds");
          yield* search();
          assert.equal(noReset.requests.length, 1);
          yield* TestClock.adjust("2 seconds");
          yield* search();
          assert.equal(noReset.requests.length, 2);
        }),
      );

      const retryAfter = makeSearch(() => json({ message: "wait" }, 429, { "retry-after": "5" }));
      yield* retryAfter.run((search) =>
        Effect.gen(function* () {
          yield* search();
          yield* TestClock.adjust("6 seconds");
          yield* search();
          assert.equal(retryAfter.requests.length, 2);
        }),
      );
    }),
  );

  it.effect("keeps the answer that used up the quota, then waits", () =>
    Effect.gen(function* () {
      const { requests, run } = makeSearch(() => {
        const answer = oneIssue();
        return new Response(answer.body, {
          status: 200,
          headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "30" },
        });
      });
      yield* run((search) =>
        Effect.gen(function* () {
          assert.equal((yield* search()).length, 1);
          // A different query is paused; the same one is cached.
          assert.deepEqual(yield* search(OTHER_MESSAGE), []);
          assert.equal(requests.length, 1);
        }),
      );
    }),
  );

  it.effect("answers a repeated query from cache for ten minutes", () =>
    Effect.gen(function* () {
      const { requests, run } = makeSearch(() => oneIssue());
      yield* run((search) =>
        Effect.gen(function* () {
          yield* search();
          yield* TestClock.adjust("9 minutes");
          assert.equal((yield* search()).length, 1);
          assert.equal(requests.length, 1);
          yield* TestClock.adjust("2 minutes");
          yield* search();
          assert.equal(requests.length, 2);
        }),
      );
    }),
  );

  it.effect("does not cache a failed search", () =>
    Effect.gen(function* () {
      let fail = true;
      const { requests, run } = makeSearch(() => (fail ? json({}, 500) : oneIssue()));
      yield* run((search) =>
        Effect.gen(function* () {
          assert.deepEqual(yield* search(), []);
          fail = false;
          assert.equal((yield* search()).length, 1);
          assert.equal(requests.length, 2);
        }),
      );
    }),
  );

  it.effect("measures the wait from when the answer arrives, not from when the request left", () =>
    Effect.gen(function* () {
      let calls = 0;
      const { requests, run } = makeSearch(
        () => (calls++ === 0 ? json({ message: "wait" }, 429, { "retry-after": "1" }) : oneIssue()),
        { delay: "2 seconds" },
      );
      yield* run((search) =>
        Effect.gen(function* () {
          const first = yield* Effect.forkChild(search());
          yield* Effect.yieldNow;
          yield* TestClock.adjust("2 seconds");
          yield* Fiber.join(first);
          assert.equal(requests.length, 1);

          // The answer came at 2 s asking for one second: nothing before 3 s.
          yield* TestClock.adjust("900 millis");
          assert.deepEqual(yield* search(), []);
          assert.equal(requests.length, 1);

          yield* TestClock.adjust("200 millis");
          const second = yield* Effect.forkChild(search());
          yield* Effect.yieldNow;
          yield* TestClock.adjust("2 seconds");
          assert.equal((yield* Fiber.join(second)).length, 1);
          assert.equal(requests.length, 2);
        }),
      );
    }),
  );

  it.effect("turns an epoch reset into a deadline when the answer arrives", () =>
    Effect.gen(function* () {
      // Sent at 0, answered at 2 s, resets at 20 s: searches wait until then.
      let calls = 0;
      const { requests, run } = makeSearch(
        () =>
          calls++ === 0
            ? json({ message: "limit" }, 403, {
                "x-ratelimit-remaining": "0",
                "x-ratelimit-reset": "20",
              })
            : oneIssue(),
        { delay: "2 seconds" },
      );
      yield* run((search) =>
        Effect.gen(function* () {
          const first = yield* Effect.forkChild(search());
          yield* Effect.yieldNow;
          yield* TestClock.adjust("2 seconds");
          yield* Fiber.join(first);
          yield* TestClock.adjust("17 seconds");
          assert.deepEqual(yield* search(), []);
          assert.equal(requests.length, 1);
        }),
      );
    }),
  );

  it.effect("shares one request among identical searches made at once", () =>
    Effect.gen(function* () {
      const { requests, run } = makeSearch(() => oneIssue(), { delay: "1 second" });
      const results = yield* run((search) =>
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(
            Effect.all(
              Array.from({ length: 20 }, () => search()),
              { concurrency: "unbounded" },
            ),
          );
          yield* Effect.yieldNow;
          yield* TestClock.adjust("1 second");
          return yield* Fiber.join(fiber);
        }),
      );

      assert.equal(requests.length, 1);
      assert.equal(results.length, 20);
      for (const candidates of results) assert.equal(candidates[0]?.number, 7);
    }),
  );

  it.effect("does not share a search between different queries", () =>
    Effect.gen(function* () {
      const { requests, run } = makeSearch(() => oneIssue(), { delay: "1 second" });
      yield* run((search) =>
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(
            Effect.all([search(MESSAGE), search(OTHER_MESSAGE)], { concurrency: 2 }),
          );
          yield* Effect.yieldNow;
          yield* TestClock.adjust("1 second");
          yield* Fiber.join(fiber);
        }),
      );
      assert.equal(requests.length, 2);
    }),
  );

  it.effect("clears a failed shared search so the next call tries again", () =>
    Effect.gen(function* () {
      let calls = 0;
      const { requests, run } = makeSearch(() => (calls++ === 0 ? json({}, 500) : oneIssue()), {
        delay: "1 second",
      });
      yield* run((search) =>
        Effect.gen(function* () {
          const failing = yield* Effect.forkChild(
            Effect.all([search(), search(), search()], { concurrency: "unbounded" }),
          );
          yield* Effect.yieldNow;
          yield* TestClock.adjust("1 second");
          assert.deepEqual(yield* Fiber.join(failing), [[], [], []]);
          assert.equal(requests.length, 1);

          const retry = yield* Effect.forkChild(search());
          yield* Effect.yieldNow;
          yield* TestClock.adjust("1 second");
          assert.equal((yield* Fiber.join(retry)).length, 1);
          assert.equal(requests.length, 2);
        }),
      );
    }),
  );

  it.effect("clears an interrupted search, and those sharing it get no candidates", () =>
    Effect.gen(function* () {
      const { requests, run } = makeSearch(() => oneIssue(), { delay: "1 second" });
      yield* run((search) =>
        Effect.gen(function* () {
          const leader = yield* Effect.forkChild(search());
          yield* Effect.yieldNow;
          const follower = yield* Effect.forkChild(search());
          yield* Effect.yieldNow;
          yield* Fiber.interrupt(leader);
          assert.deepEqual(yield* Fiber.join(follower), []);

          const retry = yield* Effect.forkChild(search());
          yield* Effect.yieldNow;
          yield* TestClock.adjust("1 second");
          assert.equal((yield* Fiber.join(retry)).length, 1);
          assert.equal(requests.length, 2);
        }),
      );
    }),
  );

  it.effect("never strands later searches, wherever the first one is interrupted", () =>
    Effect.gen(function* () {
      const { run } = makeSearch(() => oneIssue(), { delay: "1 second" });
      yield* run((search) =>
        Effect.gen(function* () {
          for (const yieldsBeforeInterrupt of [0, 1, 2, 3]) {
            const leader = yield* Effect.forkChild(search());
            for (let index = 0; index < yieldsBeforeInterrupt; index++) yield* Effect.yieldNow;
            yield* Fiber.interrupt(leader);

            const next = yield* Effect.forkChild(search());
            yield* Effect.yieldNow;
            yield* TestClock.adjust("1 second");
            const result = yield* Fiber.join(next).pipe(Effect.timeout("5 seconds"));
            assert.isAtMost(result.length, 1);
          }
        }),
      );
    }),
  );
});
