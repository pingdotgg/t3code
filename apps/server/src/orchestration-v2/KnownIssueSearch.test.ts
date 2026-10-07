import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
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
  "plan",
  "hunter2",
  "alex",
  "example",
];

describe("buildKnownIssueQuery", () => {
  it("builds from the fixed vocabulary only, dropping T3 guidance", () => {
    const query = KnownIssueSearch.buildKnownIssueQuery({
      message:
        "The provider could not start this turn: Failed to read attachment '3f2b8c1e-aaaa-4bbb-8ccc-0123456789ab'. Retry the turn; if it keeps failing, check the provider setup and server logs.",
      driver: "codex",
    });
    assert.equal(query, `start turn failed read attachment codex ${REPO_SUFFIX}`);
  });

  it("reads internal ids as the vocabulary words they contain, nothing else", () => {
    assert.equal(
      KnownIssueSearch.buildKnownIssueQuery({
        message: "Claude provider turn provider-turn:abc is still active.",
        driver: "claudeAgent",
      }),
      `turn still active claude ${REPO_SUFFIX}`,
    );
  });

  // Each of these once sent the private value to a public search.
  it.each([
    ["Invalid API_KEY: correcthorse", "correcthorse"],
    ["Failed to authenticate token : correcthorse", "correcthorse"],
    ["Connection refused by buildhost while reading the stream", "buildhost"],
    ["Failed to read repo acquisition-plans: permission denied", "acquisition"],
    ["Failed to checkout branch acquisition-plan: permission denied", "plan"],
    ["Failed to read /Users/alex/.env: permission denied", "alex"],
    ["Failed to reach https://api.example.com/v1?key=hunter2 connection reset", "example"],
  ])("keeps %j from leaking %s", (message, privateWord) => {
    const query = KnownIssueSearch.buildKnownIssueQuery({ message, driver: null });
    for (const word of PRIVATE_WORDS) {
      assert.notInclude(query ?? "", word);
    }
    assert.notInclude(query ?? "", privateWord);
  });

  it("searches nothing when fewer than two vocabulary words match", () => {
    assert.isNull(
      KnownIssueSearch.buildKnownIssueQuery({
        message: "Invalid API_KEY: correcthorse",
        driver: "codex",
      }),
    );
    assert.isNull(
      KnownIssueSearch.buildKnownIssueQuery({
        message: "Failed. '/Users/alex/x' 12345 3f2b8c1e-aaaa-4bbb-8ccc-0123456789ab",
        driver: "codex",
      }),
    );
    // The driver does not count toward the two words.
    assert.isNull(KnownIssueSearch.buildKnownIssueQuery({ message: "timeout", driver: "codex" }));
  });

  it("keeps at most six vocabulary words", () => {
    const query = KnownIssueSearch.buildKnownIssueQuery({
      message: "attachment image read start turn session open resume stream closed timeout timed",
      driver: null,
    });
    assert.equal(query, `attachment image read start turn session ${REPO_SUFFIX}`);
  });

  it("only emits vocabulary words and fixed driver keywords, whatever the input", () => {
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
      "Failed to authenticate token : correcthorse timed out with buildhost refused",
      "The provider session could not be opened. Check that the provider is installed and signed in, then retry the turn.",
      "Request to https://internal.corp/x failed: connection reset, permission denied, sandbox crashed",
      "Ünïcode 😀 failed to read attachment in /home/me/acquisition-plans",
    ];
    const allowed = new Set([
      ...KnownIssueSearch.KNOWN_ISSUE_VOCABULARY,
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
        const words = query.slice(0, -REPO_SUFFIX.length - 1).split(" ");
        for (const word of words) assert.isTrue(allowed.has(word), `${word} is not allowed`);
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
) => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const layer = KnownIssueSearch.layerWithHttpClient.pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          requests.push(request);
          const answer = respond(request);
          return answer instanceof Error
            ? Effect.die(answer)
            : Effect.succeed(HttpClientResponse.fromWeb(request, answer));
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
const QUERY = `failed read attachment codex ${REPO_SUFFIX}`;
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
          assert.deepEqual(yield* search("Failed to open session"), []);
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
});
