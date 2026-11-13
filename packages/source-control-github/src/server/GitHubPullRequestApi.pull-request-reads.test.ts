import {
  Effect,
  GitHubPullRequestApi,
  GitHubRequestPolicy,
  assert,
  emptyList,
  emptySearch,
  encodeJson,
  expect,
  layer,
  listedPullRequests,
  mockedExecute,
  mockedStackMemberships,
  output,
  pullRequests,
  queryAt,
  searchItem,
  searchOfCall,
  searchPage,
  searchQueryOfCall,
  varsAt,
} from "./GitHubPullRequestApi-fixtures.testkit.ts";

layer("GitHubPullRequestApi.layer", (it) => {
  it.effect("carries every repository and every qualifier into one search", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(searchPage([])));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.searchPullRequests({
        cwd: "/w",
        host: "github.com",
        repositories: ["acme/web", "pingdotgg/t3code"],
        state: "closed",
        involvement: "reviewing",
        viewer: "bilal",
        limit: 10,
        query: "pull requests page",
        cursor: { updatedBefore: "2026-07-02T00:00:00Z", delivered: 10 },
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 1);
      assert.strictEqual(
        searchQueryOfCall(0),
        'is:pr is:closed is:unmerged review-requested:bilal "pull requests page" ' +
          "updated:<=2026-07-02T00:00:00Z sort:updated-desc repo:acme/web repo:pingdotgg/t3code",
      );
    }),
  );

  it.effect("keeps a searched-for qualifier inside the phrase", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(searchPage([])));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.searchPullRequests({
        cwd: "/w",
        host: "github.com",
        repositories: ["acme/web"],
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        query: 'x" is:merged repo:evil/repo',
      });

      assert.strictEqual(
        searchQueryOfCall(0),
        'is:pr is:open "x\\" is:merged repo:evil/repo" sort:updated-desc repo:acme/web',
      );
    }),
  );

  it.effect("refuses to search for a repository GitHub cannot address", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const failure = yield* Effect.flip(
        cli.searchPullRequests({
          cwd: "/w",
          host: "github.com",
          repositories: ["acme/web", "acme/web is:merged"],
          state: "open",
          involvement: "all",
          viewer: "bilal",
          limit: 10,
        }),
      );

      assert.strictEqual(failure._tag, "GitHubRepositorySelectorError");
      assert.strictEqual(mockedExecute.mock.calls.length, 0);
    }),
  );

  it.effect("files each searched row under the repository it came from", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(
        Effect.succeed(
          searchPage([
            searchItem(7, "acme/web", "2026-07-03T00:00:00Z"),
            searchItem(9, "pingdotgg/t3code", "2026-07-02T00:00:00Z"),
            {},
          ]),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const batch = yield* cli.searchPullRequests({
        cwd: "/w",
        host: "github.com",
        repositories: ["acme/web", "pingdotgg/t3code"],
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
      });

      assert.deepStrictEqual(
        batch.items.map((item) => [item.repository, item.number, item.author?.avatarUrl]),
        [
          ["acme/web", 7, "https://avatars/octocat"],
          ["pingdotgg/t3code", 9, "https://avatars/octocat"],
        ],
      );
      assert.deepStrictEqual(
        batch.items.map((item) => [item.additions, item.deletions]),
        [
          [0, 0],
          [0, 0],
        ],
      );
      assert.isFalse(batch.truncated);
    }),
  );

  it.effect("reports truncation from the extra row, and from a page GitHub says has more", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(
            searchPage([
              searchItem(1, "acme/web", "2026-07-03T00:00:00Z"),
              searchItem(2, "acme/web", "2026-07-02T00:00:00Z"),
              searchItem(3, "acme/web", "2026-07-01T00:00:00Z"),
            ]),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(searchPage([searchItem(1, "acme/web", "2026-07-03T00:00:00Z")], true)),
        );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const read = () =>
        cli.searchPullRequests({
          cwd: "/w",
          host: "github.com",
          repositories: ["acme/web"],
          state: "open",
          involvement: "all",
          viewer: "bilal",
          limit: 2,
        });

      const overflowing = yield* read();
      const capped = yield* read();

      assert.strictEqual(overflowing.items.length, 2);
      assert.isTrue(overflowing.truncated);
      assert.isTrue(capped.truncated);
    }),
  );

  it.effect("enriches only the visible fallback rows after filtering and widening", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(emptySearch()));
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(listedPullRequests(3, 1, () => ({ isDraft: true })))),
      );
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(listedPullRequests(6, 1, (number) => ({ isDraft: number < 4 })))),
      );
      mockedStackMemberships.mockReturnValueOnce(
        Effect.succeed(
          output(
            encodeJson({
              data: {
                _0_repository: {
                  pullRequest: {
                    stack: { number: 3, size: 2, baseRefName: "main" },
                    stackEntry: { position: 1 },
                  },
                },
                _1_repository: { pullRequest: { stack: null, stackEntry: null } },
              },
            }),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const batch = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 2,
        filters: { draft: "hide" },
      });
      expect(batch.items.map((item) => item.number)).toEqual([4, 5]);
      expect(batch.items[0]?.stack).toEqual({ number: 3, size: 2, base: "main", position: 1 });
      expect(batch.items[1]?.stack).toBeUndefined();
      expect(batch.truncated).toBe(true);
      expect(batch.continues).toBe(false);
      expect(mockedStackMemberships).toHaveBeenCalledTimes(1);
      const membership = mockedStackMemberships.mock.calls[0]?.[0];
      const numbers = Object.entries(
        membership?.kind === "graphql" ? (membership.variables ?? {}) : {},
      )
        .filter(([name]) => name.endsWith("_number"))
        .map(([, number]) => number);
      expect(numbers).toEqual([4, 5]);
    }),
  );

  it.effect("batches membership reads and keeps successful rows when one chunk fails", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequests(27, 1))));
      mockedStackMemberships.mockImplementation((input) =>
        input.kind === "graphql" && Object.values(input.variables ?? {}).includes(26)
          ? Effect.fail(
              new GitHubRequestPolicy.GitHubApiResponseError({
                host: "github.com",
                operation: "listPullRequestStackMemberships",
                status: 502,
              }),
            )
          : Effect.succeed(
              output(
                encodeJson({
                  data: Object.fromEntries(
                    Object.keys(input.kind === "graphql" ? (input.variables ?? {}) : {})
                      .filter((name) => name.endsWith("_number"))
                      .map((name, index) => [
                        name.replace(/number$/, "repository"),
                        {
                          pullRequest:
                            index === 0
                              ? {
                                  stack: { number: 3, size: 2, baseRefName: "main" },
                                  stackEntry: { position: 1 },
                                }
                              : { stack: null, stackEntry: null },
                        },
                      ]),
                  ),
                }),
              ),
            ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const batch = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 26,
      });
      expect(batch.items.map((item) => item.number)).toEqual(
        Array.from({ length: 26 }, (_, i) => i + 1),
      );
      expect(batch.items[0]?.stack).toEqual({ number: 3, size: 2, base: "main", position: 1 });
      expect(batch.items[25]?.stack).toBeUndefined();
      expect(batch.truncated).toBe(true);
      expect(batch.continues).toBe(true);
      expect(mockedStackMemberships).toHaveBeenCalledTimes(2);
    }),
  );

  it.effect("reads the line counts in chunks, and files them back by position", () =>
    Effect.gen(function* () {
      const changeRequests = Array.from({ length: 26 }, (_, index) => ({
        repository: "acme/web",
        number: index + 1,
      }));
      mockedExecute.mockImplementation((call) =>
        Effect.succeed(
          output(
            encodeJson({
              data: Object.fromEntries(
                Object.keys(call.kind === "graphql" ? (call.variables ?? {}) : {})
                  .filter((name) => name.endsWith("_number"))
                  .map((name, index) => [
                    name.replace(/number$/, "repository"),
                    { pullRequest: index === 0 ? { additions: 4, deletions: 1 } : null },
                  ]),
              ),
            }),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const stats = yield* cli.listPullRequestStats({
        cwd: "/w",
        host: "github.com",
        changeRequests,
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 2);
      assert.deepStrictEqual(stats, [
        { repository: "acme/web", number: 1, additions: 4, deletions: 1 },
        { repository: "acme/web", number: 26, additions: 4, deletions: 1 },
      ]);
      expect(queryAt(0)).toContain("_0_repository:repository(owner:$_0_owner name:$_0_name)");
      expect(varsAt(0)).toMatchObject({ _0_owner: "acme", _0_name: "web", _24_number: 25 });
    }),
  );

  it.effect("carries the further narrowings into the search as qualifiers", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation((call) =>
        Effect.succeed(
          call.kind === "graphql" && call.operationName === "PullRequestList"
            ? emptyList()
            : emptySearch(),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        filters: {
          draft: "hide",
          review: "changes-requested",
          checks: "failing",
          labels: [["needs design"], ['quo"te']],
          excludedLabels: ["wip"],
          author: "octocat",
        },
      });

      expect(searchOfCall(0)).toBe(
        'is:pr is:open label:"needs design" label:"quote" -label:"wip" author:"octocat" ' +
          "draft:false review:changes_requested status:failure sort:updated-desc repo:acme/web",
      );
    }),
  );

  it.effect('resolves an author filter of "me" to the viewer, not the literal word', () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation((call) =>
        Effect.succeed(
          call.kind === "graphql" && call.operationName === "PullRequestList"
            ? emptyList()
            : emptySearch(),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        filters: { author: "me" },
      });

      expect(searchOfCall(0)).toBe('is:pr is:open author:"bilal" sort:updated-desc repo:acme/web');
    }),
  );

  it.effect("sends one label qualifier per group, its names joined the way GitHub ors them", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation((call) =>
        Effect.succeed(
          call.kind === "graphql" && call.operationName === "PullRequestList"
            ? emptyList()
            : emptySearch(),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        filters: { labels: [["size:S", "size:XS"], ["bug"]] },
      });

      expect(searchOfCall(0)).toBe(
        'is:pr is:open label:"size:S","size:XS" label:"bug" sort:updated-desc repo:acme/web',
      );
    }),
  );

  it.effect(
    "falls back for a repository the index does not cover under a checks filter, keeping only the matching rows",
    () =>
      Effect.gen(function* () {
        mockedExecute.mockReturnValueOnce(Effect.succeed(emptySearch()));
        mockedExecute.mockReturnValueOnce(
          Effect.succeed(
            output(
              listedPullRequests(2, 1, (number) => ({
                checks: number === 1 ? "SUCCESS" : "FAILURE",
              })),
            ),
          ),
        );
        const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

        const batch = yield* cli.listPullRequests({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          state: "open",
          involvement: "all",
          viewer: "bilal",
          limit: 10,
          filters: { checks: "passing" },
        });

        expect(searchOfCall(1)).toBeUndefined();
        assert.deepStrictEqual(
          batch.items.map((item) => item.number),
          [1],
        );
      }),
  );

  it.effect("fails a checks filter for a row whose checks are still pending", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(emptySearch()));
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(listedPullRequests(1, 1, () => ({ checks: "PENDING" })))),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const batch = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        filters: { checks: "passing" },
      });

      assert.deepStrictEqual(batch.items, []);
    }),
  );

  it.effect("escapes a backslash before the quote it would otherwise let out", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation((call) =>
        Effect.succeed(
          call.kind === "graphql" && call.operationName === "PullRequestList"
            ? emptyList()
            : emptySearch(),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        query: String.raw`a\" is:merged`,
      });

      expect(searchOfCall(0)).toBe(
        String.raw`is:pr is:open "a\\\" is:merged" sort:updated-desc repo:acme/web`,
      );
    }),
  );

  it.effect("carries on from the instant the last slice ended on", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output(pullRequests(3, 1))));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const batch = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        cursor: { updatedBefore: "2026-07-02T00:00:00Z", delivered: 10 },
      });

      expect(searchOfCall(0)).toBe(
        "is:pr is:open updated:<=2026-07-02T00:00:00Z sort:updated-desc repo:acme/web",
      );
      assert.isTrue(batch.continues);
    }),
  );

  it.effect("answers a search that found nothing with nothing, not with the whole repository", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(emptySearch()));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const batch = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        query: "fdsfklj",
      });

      assert.strictEqual(batch.items.length, 0);
      assert.strictEqual(mockedExecute.mock.calls.length, 1);
    }),
  );

  it.effect("keeps state and involvement filters on the search-free fallback", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(emptySearch()));
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            listedPullRequests(4, 1, (number) => ({
              state: number === 4 ? "OPEN" : "CLOSED",
              ...(number === 3 ? { mergedAt: "2026-07-03T00:00:00Z" } : {}),
              reviewRequests:
                number === 2 ? [{ slug: "platform", name: "Platform" }] : [{ login: "bilal" }],
            })),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const batch = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "closed",
        involvement: "reviewing",
        viewer: "bilal",
        limit: 10,
      });

      expect(batch.items.map((item) => item.number)).toEqual([1, 2]);
      expect(searchOfCall(1)).toBeUndefined();
      assert.isFalse(batch.continues);
    }),
  );

  it.effect("grows the search-free fallback until it fills the filtered page", () =>
    Effect.gen(function* () {
      const unrelated = () => ({ reviewRequests: [{ login: "somebody-else" }] });
      mockedExecute.mockReturnValueOnce(Effect.succeed(emptySearch()));
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(listedPullRequests(3, 1, unrelated))),
      );
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            listedPullRequests(4, 1, (number) =>
              number === 4 ? { reviewRequests: [{ login: "bilal" }] } : unrelated(),
            ),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const batch = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "reviewing",
        viewer: "bilal",
        limit: 2,
      });

      expect(batch.items.map((item) => item.number)).toEqual([4]);
      expect(varsAt(1)["first"]).toBe(3);
      expect(varsAt(2)["first"]).toBe(6);
      assert.isFalse(batch.truncated);
    }),
  );
});
