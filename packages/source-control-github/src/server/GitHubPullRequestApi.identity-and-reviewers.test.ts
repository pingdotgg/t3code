import {
  Effect,
  GitHubPullRequestApi,
  NODE_ID_QUERY,
  assert,
  callAt,
  encodeJson,
  expect,
  layer,
  mockedExecute,
  output,
  varsAt,
} from "./GitHubPullRequestApi-fixtures.testkit.ts";

layer("GitHubPullRequestApi.layer", (it) => {
  it.effect("takes labels off one at a time, naming each in the path encoded", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("[]")));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.setLabels({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        labels: ["good first issue", "area/web"],
        applied: false,
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 2);
      expect(callAt(0)).toMatchObject({
        method: "DELETE",
        path: "repos/acme/web/issues/7/labels/good%20first%20issue",
      });
      expect(callAt(1)).toMatchObject({
        method: "DELETE",
        path: "repos/acme/web/issues/7/labels/area%2Fweb",
      });
    }),
  );

  it.effect("reads every page of viewed files, and says so when there are too many", () =>
    Effect.gen(function* () {
      const page = (index: number, hasNextPage: boolean) =>
        Effect.succeed(
          output(
            encodeJson({
              data: {
                repository: {
                  pullRequest: {
                    files: {
                      pageInfo: { hasNextPage, endCursor: `cursor-${index}` },
                      nodes: [
                        { path: `src/file${index}.ts`, viewerViewedState: "VIEWED" },
                        { path: `src/other${index}.ts`, viewerViewedState: "UNVIEWED" },
                      ],
                    },
                  },
                },
              },
            }),
          ),
        );
      mockedExecute
        .mockReturnValueOnce(page(0, true))
        .mockReturnValueOnce(page(1, true))
        .mockReturnValueOnce(page(2, false));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const viewed = yield* cli.getPullRequestFilesViewed({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 3);
      expect([varsAt(0)["after"], varsAt(1)["after"], varsAt(2)["after"]]).toEqual([
        undefined,
        "cursor-0",
        "cursor-1",
      ]);
      assert.isFalse(viewed.truncated);
      expect(viewed.files.map((file) => [file.path, file.state])).toEqual([
        ["src/file0.ts", "viewed"],
        ["src/other0.ts", "unviewed"],
        ["src/file1.ts", "viewed"],
        ["src/other1.ts", "unviewed"],
        ["src/file2.ts", "viewed"],
        ["src/other2.ts", "unviewed"],
      ]);
    }),
  );

  it.effect("stops paging viewed files rather than following a change without end", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(
        Effect.succeed(
          output(
            encodeJson({
              data: {
                repository: {
                  pullRequest: {
                    files: {
                      pageInfo: { hasNextPage: true, endCursor: "cursor" },
                      nodes: [{ path: "src/file.ts", viewerViewedState: "VIEWED" }],
                    },
                  },
                },
              },
            }),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const viewed = yield* cli.getPullRequestFilesViewed({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 2);
      assert.isTrue(viewed.truncated);
    }),
  );

  it.effect("does not remember a node id lookup that failed", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(Effect.succeed(output('{"message":"not found"}')))
        .mockReturnValueOnce(
          Effect.succeed(
            output(encodeJson({ data: { repository: { pullRequest: { id: "PR_25" } } } })),
          ),
        )
        .mockReturnValueOnce(Effect.succeed(output("{}")));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const write = () =>
        cli.setPullRequestFilesViewed({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 25,
          files: [{ path: "src/a.ts", viewed: true }],
        });

      const error = yield* Effect.flip(write());
      assert.strictEqual(error._tag, "GitHubPullRequestReadError");

      yield* write();

      assert.strictEqual(mockedExecute.mock.calls.length, 3);
      expect(varsAt(2)["_0_pullRequestId"]).toEqual("PR_25");
    }),
  );

  it.effect("keeps the pull request being ticked through, not the one looked up first", () =>
    Effect.gen(function* () {
      const HOT = 9_000;
      const lookupsOf = new Map<number, number>();
      mockedExecute.mockImplementation((input) => {
        if (input.kind !== "graphql" || input.operationName !== NODE_ID_QUERY) {
          return Effect.succeed(output("{}"));
        }
        const number = Number(input.variables?.["number"]);
        lookupsOf.set(number, (lookupsOf.get(number) ?? 0) + 1);
        return Effect.succeed(
          output(encodeJson({ data: { repository: { pullRequest: { id: `PR_${number}` } } } })),
        );
      });
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const tick = (number: number) =>
        cli.setPullRequestFilesViewed({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number,
          files: [{ path: "src/a.ts", viewed: true }],
        });

      yield* tick(HOT);
      for (let filled = 0; filled < GitHubPullRequestApi.NODE_ID_CACHE_CAPACITY; filled += 1) {
        yield* tick(HOT + 1 + filled);
        yield* tick(HOT);
      }

      assert.strictEqual(lookupsOf.get(HOT), 1);
    }),
  );
});
