import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/http";

import * as KnownIssueSearch from "./KnownIssueSearch.ts";

const REPO_SUFFIX = "repo:pingdotgg/t3code is:issue";

describe("buildKnownIssueQuery", () => {
  it("keeps distinctive words and drops T3 guidance, quoted ids, and the uuids inside them", () => {
    const query = KnownIssueSearch.buildKnownIssueQuery({
      message:
        "The provider could not start this turn: Failed to read attachment '3f2b8c1e-aaaa-4bbb-8ccc-0123456789ab-5d6e7f80-1111-4222-8333-0123456789ab'. Retry the turn; if it keeps failing, check the provider setup and server logs.",
      driver: "codex",
    });
    assert.equal(query, `provider start turn failed read attachment codex ${REPO_SUFFIX}`);
  });

  it("drops internal ids", () => {
    assert.equal(
      KnownIssueSearch.buildKnownIssueQuery({
        message: "Claude provider turn provider-turn:abc is still active.",
        driver: "claudeAgent",
      }),
      `claude provider turn still active ${REPO_SUFFIX}`,
    );
  });

  it("drops paths, including home directories, and the filename after a space", () => {
    const query = KnownIssueSearch.buildKnownIssueQuery({
      message:
        "ENOENT: no such file or directory, open '/Users/alex/projects/app/.env' via ~/work/tool and C:\\Users\\alex\\secret notes.txt",
      driver: null,
    });
    assert.equal(query, `enoent file directory open ${REPO_SUFFIX}`);
    for (const leaked of ["Users", "alex", "projects", ".env", "secret", "notes", "txt"]) {
      assert.notInclude(query, leaked);
    }
  });

  it("drops URLs with their query strings", () => {
    const query = KnownIssueSearch.buildKnownIssueQuery({
      message: "Failed to reach https://api.example.com/v1/messages?key=abc123 (connection reset)",
      driver: "codex",
    });
    assert.equal(query, `failed reach connection reset codex ${REPO_SUFFIX}`);
    assert.notInclude(query, "example");
    assert.notInclude(query, "abc123");
  });

  it("never keeps a credential, whatever its shape", () => {
    const query = KnownIssueSearch.buildKnownIssueQuery({
      message:
        "Authorization failed: Bearer sk-ant-api03-abcdef rejected by Anthropic; token deadbeefcafe1234 and api_key=hunter2 refused, password correcthorse",
      driver: null,
    });
    assert.isNotNull(query);
    for (const leaked of ["sk-ant", "abcdef", "deadbeef", "hunter2", "correcthorse", "bearer"]) {
      assert.notInclude(query!.toLowerCase(), leaked);
    }
  });

  it("keeps at most six words and no number", () => {
    const query = KnownIssueSearch.buildKnownIssueQuery({
      message:
        "Request failed with status 429 because alpha bravo charlie delta echo foxtrot golf hotel",
      driver: null,
    });
    assert.equal(query, `request failed status because alpha bravo ${REPO_SUFFIX}`);
  });

  it("searches nothing when no distinctive word survives", () => {
    assert.isNull(
      KnownIssueSearch.buildKnownIssueQuery({
        message: "Failed. '/Users/alex/x' 12345 3f2b8c1e-aaaa-4bbb-8ccc-0123456789ab",
        driver: "codex",
      }),
    );
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

const searchWith = (
  respond: (request: HttpClientRequest.HttpClientRequest) => Response | Error,
  requests: Array<HttpClientRequest.HttpClientRequest> = [],
) =>
  Effect.gen(function* () {
    const search = yield* KnownIssueSearch.KnownIssueSearch;
    return yield* search.search({ message: "spawn codex ENOENT", driver: "codex" });
  }).pipe(
    Effect.provide(
      KnownIssueSearch.layerWithHttpClient.pipe(
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
      ),
    ),
  );

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("KnownIssueSearch", () => {
  it.effect("asks GitHub for the repository's issues and returns clean candidates", () =>
    Effect.gen(function* () {
      const requests: Array<HttpClientRequest.HttpClientRequest> = [];
      const candidates = yield* searchWith(
        () =>
          json({
            items: [
              {
                number: 7,
                title: "  Codex\nbinary   missing after update ",
                state: "open",
                html_url: "https://evil.example/not-used",
              },
            ],
          }),
        requests,
      );

      assert.deepEqual(candidates, [
        {
          number: 7,
          title: "Codex binary missing after update",
          state: "open",
          url: "https://github.com/pingdotgg/t3code/issues/7",
        },
      ]);
      const request = requests[0]!;
      assert.equal(request.url, "https://api.github.com/search/issues");
      assert.deepEqual(request.urlParams.params, [
        ["q", `spawn codex enoent ${REPO_SUFFIX}`],
        ["per_page", "5"],
      ]);
      assert.equal(request.headers["accept"], "application/vnd.github+json");
      assert.isString(request.headers["user-agent"]);
      assert.isUndefined(request.headers["authorization"]);
    }),
  );

  it.effect("returns no candidates when GitHub rate limits, errors, or answers oddly", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* searchWith(() => json({ message: "rate limit" }, 403)), []);
      assert.deepEqual(yield* searchWith(() => json({ message: "slow down" }, 429)), []);
      assert.deepEqual(yield* searchWith(() => json({ items: "nope" })), []);
      assert.deepEqual(yield* searchWith(() => new Response("<html>", { status: 200 })), []);
      assert.deepEqual(yield* searchWith(() => new Error("connection reset")), []);
    }),
  );

  it.effect("skips the network when the failure has nothing to search for", () =>
    Effect.gen(function* () {
      const requests: Array<HttpClientRequest.HttpClientRequest> = [];
      const result = yield* Effect.gen(function* () {
        const search = yield* KnownIssueSearch.KnownIssueSearch;
        return yield* search.search({ message: "12345 /Users/alex/x", driver: null });
      }).pipe(
        Effect.provide(
          KnownIssueSearch.layerWithHttpClient.pipe(
            Layer.provide(
              Layer.succeed(
                HttpClient.HttpClient,
                HttpClient.make((request) => {
                  requests.push(request);
                  return Effect.die("unexpected request");
                }),
              ),
            ),
          ),
        ),
      );
      assert.deepEqual(result, []);
      assert.equal(requests.length, 0);
    }),
  );
});
