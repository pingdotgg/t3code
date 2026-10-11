import { expect, it } from "@effect/vitest";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as FileSystem from "effect/FileSystem";
import * as Redacted from "effect/Redacted";
import { ChildProcessSpawner } from "effect/process";
import * as GitHubApi from "./GitHubApi.ts";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import { runGitHubStackAction as runStackAction } from "./githubStackActions.ts";

/**
 * One request as the fake saw it, flattened to words: the path or document, then each variable
 * or body field as `name=value`, so an assertion reads as "this request carried that value".
 */
type Call = ReadonlyArray<string>;
type Send = (
  call: Call,
  kind: "graphql" | "rest",
) => Effect.Effect<string, GitHubApi.GitHubApiError>;

/** Every git command the cascade ran, in order; none actually runs. */
let gitCalls: Array<ReadonlyArray<string>> = [];
const fakeGit = Layer.mergeAll(
  TestSourceControlHost.layer({
    process: {
      run: (input) =>
        Effect.sync(() => {
          gitCalls.push(input.args);
          const stdout =
            input.args[0] === "rev-parse" || input.args[0] === "merge-base" ? "new-sha\n" : "";
          return {
            exitCode: ChildProcessSpawner.ExitCode(0),
            stdout,
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        }),
    },
  }),
  FileSystem.layerNoop({ makeTempDirectoryScoped: () => Effect.succeed("/tmp/scratch") }),
);

const runGitHubStackAction = (send: Send, input: Parameters<typeof runStackAction>[0]) =>
  runStackAction(input).pipe(
    Effect.provide(
      Layer.mergeAll(
        fakeGit,
        Layer.mock(GitHubApi.GitHubApi)({
          credential: () => Effect.succeed({ token: Redacted.make("token"), fingerprint: "fp" }),
          graphql: (request) => {
            // GitHub refuses a document that declares a variable it never uses.
            const declared = [...request.query.matchAll(/\$(\w+)\s*:/g)].map((match) => match[1]!);
            const unused = declared.filter(
              (name) => !new RegExp(`\\$${name}(?!\\w)(?!\\s*:)`).test(request.query),
            );
            if (unused.length > 0) {
              return Effect.die(new Error(`Variables declared but not used: ${unused.join(", ")}`));
            }
            return send(words(request.query, request.variables), "graphql");
          },
          rest: (request) =>
            send(words(request.path, request.body), "rest").pipe(
              Effect.map((body) => ({
                status: 200,
                headers: {},
                body,
                truncated: false,
                invalidUtf8: false,
              })),
            ),
        }),
      ),
    ),
  );

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function words(head: string, fields: unknown): Call {
  return [
    head,
    ...Object.entries((fields ?? {}) as Record<string, unknown>).map(
      ([key, value]) => `${key}=${typeof value === "string" ? value : encodeJson(value)}`,
    ),
  ];
}

const isMutation = (call: Call) => call[0]!.startsWith("mutation");

const stack = [
  {
    number: 50,
    url: "https://api.github.com/repos/acme/web/stacks/50",
    base: { ref: "main" },
    pull_requests: [
      {
        number: 1,
        title: "Base",
        head: { ref: "base", sha: "aaa" },
        state: "closed",
        merged_at: "2026-01-01T00:00:00Z",
      },
      {
        number: 2,
        title: "Middle",
        head: { ref: "middle", sha: "bbb" },
        state: "open",
        draft: false,
      },
      { number: 3, title: "Top", head: { ref: "top", sha: "ccc" }, state: "open", draft: false },
    ],
  },
];
const input = {
  cwd: "/repo",
  repository: "acme/web",
  host: "github.com",
  number: 3,
  stackNumber: 50,
  expectedStackHeads: [
    { number: 2, headSha: "bbb" },
    { number: 3, headSha: "ccc" },
  ],
  action: "merge" as const,
};
const access = {
  data: {
    repository: {
      pr2: { headRepository: { viewerPermission: "WRITE" }, maintainerCanModify: false },
      pr3: { headRepository: { viewerPermission: "WRITE" }, maintainerCanModify: false },
    },
  },
};

const branch = (number: number, headRefOid: string, behindBy = 1, processed: string[] = []) => ({
  data: {
    processed: processed.map((headRefOid) => ({ headRefOid })),
    repository: {
      pullRequest: { id: `PR_${number}`, headRefOid, baseRef: { compare: { behindBy } } },
    },
  },
});
const rebased = {
  data: { updatePullRequestBranch: { pullRequest: { headRefOid: "rebased-sha" } } },
};
const rebaseResponses = [branch(2, "bbb"), rebased, branch(3, "ccc", 1, ["rebased-sha"]), rebased];

function fake(responses: readonly unknown[]) {
  const calls: Call[] = [];
  const execute: Send = (call) =>
    Effect.sync(() => {
      calls.push(call);
      const value = responses[calls.length - 1];
      if (value === undefined) throw new Error("Unexpected GitHub request");
      return encodeJson(value);
    });
  return { execute, calls };
}

it.effect("submits one atomic merge with the reviewed head and respects the merge queue", () =>
  Effect.gen(function* () {
    const api = fake([stack, { status: "enqueued", details: {} }]);
    yield* runGitHubStackAction(api.execute, { ...input, mergeMethod: "squash" });
    expect(api.calls).toHaveLength(2);
    expect(api.calls[1]).toContain("repos/acme/web/pulls/3/merge-async");
    expect(api.calls[1]).toContain("sha=ccc");
    expect(api.calls[1]).toContain("merge_action=default");
    expect(api.calls[1]).toContain("merge_method=squash");
  }),
);

it.effect("merges through the selected layer without including later draft layers", () =>
  Effect.gen(function* () {
    const fiveLayers = [
      {
        ...stack[0],
        pull_requests: Array.from({ length: 5 }, (_, index) => ({
          number: index + 1,
          head: { ref: `layer-${index + 1}`, sha: `sha-${index + 1}` },
          state: "open",
          draft: index >= 3,
        })),
      },
    ];
    const api = fake([fiveLayers, { status: "merged", details: {} }]);
    yield* runGitHubStackAction(api.execute, {
      ...input,
      number: 3,
      expectedStackHeads: [1, 2, 3].map((number) => ({ number, headSha: `sha-${number}` })),
    });
    expect(api.calls).toHaveLength(2);
    expect(api.calls[1]).toContain("repos/acme/web/pulls/3/merge-async");
    expect(api.calls[1]).toContain("sha=sha-3");
    expect(api.calls[1]).toContain("merge_action=default");
  }),
);

it.effect("rejects stale reviewed heads below a selected middle layer", () =>
  Effect.gen(function* () {
    const api = fake([stack]);
    const result = yield* runGitHubStackAction(api.execute, {
      ...input,
      number: 2,
      expectedStackHeads: [{ number: 2, headSha: "old-head" }],
    }).pipe(Effect.result);
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "GitHubStackChangedError" } });
    expect(api.calls).toHaveLength(1);
  }),
);

it.effect("does not merge from an already merged layer", () =>
  Effect.gen(function* () {
    const api = fake([stack]);
    const result = yield* runGitHubStackAction(api.execute, {
      ...input,
      number: 1,
      expectedStackHeads: [],
    }).pipe(Effect.result);
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "GitHubStackUnsupportedError" },
    });
    expect(api.calls).toHaveLength(1);
  }),
);

it.effect("polls an accepted merge and reports a later rule rejection", () =>
  Effect.gen(function* () {
    const api = fake([
      stack,
      { status: "pending", details: { uuid: "operation" } },
      { status: "failed", details: { message: "Required checks have not passed" } },
    ]);
    const fiber = yield* runGitHubStackAction(api.execute, input).pipe(
      Effect.result,
      Effect.forkChild,
    );
    yield* TestClock.adjust("1 second");
    const result = yield* Fiber.join(fiber);
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "GitHubStackMergeRejectedError" },
    });
    expect(api.calls[2]).toContain("repos/acme/web/pulls/3/merge-async/operation");
  }),
);

it.effect("retains stack identity and a rejection response without a message", () =>
  Effect.gen(function* () {
    const rejection = { status: "failed", details: {} };
    const api = fake([stack, rejection]);
    const result = yield* runGitHubStackAction(api.execute, input).pipe(Effect.result);
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "GitHubStackMergeRejectedError",
        repository: input.repository,
        number: input.number,
        stackNumber: input.stackNumber,
        cause: rejection,
      },
    });
  }),
);

it.effect("refuses a changed stack before performing any mutation", () =>
  Effect.gen(function* () {
    const api = fake([stack]);
    const result = yield* runGitHubStackAction(api.execute, {
      ...input,
      expectedStackHeads: [
        { number: 2, headSha: "old" },
        { number: 3, headSha: "ccc" },
      ],
    }).pipe(Effect.result);
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "GitHubStackChangedError" } });
    expect(api.calls).toHaveLength(1);
  }),
);

it.effect("refuses the entire rebase before mutation when a later fork denies write access", () =>
  Effect.gen(function* () {
    const api = fake([
      stack,
      {
        data: {
          repository: {
            ...access.data.repository,
            pr3: { headRepository: { viewerPermission: "READ" }, maintainerCanModify: false },
          },
        },
      },
    ]);
    const result = yield* runGitHubStackAction(api.execute, {
      ...input,
      action: "update-branch",
    }).pipe(Effect.result);
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "GitHubStackPermissionError" },
    });
    expect(api.calls).toHaveLength(2);
  }),
);

it.effect("allows a fork that explicitly permits maintainer updates", () =>
  Effect.gen(function* () {
    const api = fake([
      stack,
      {
        data: {
          repository: {
            ...access.data.repository,
            pr3: { headRepository: { viewerPermission: "READ" }, maintainerCanModify: true },
          },
        },
      },
      ...rebaseResponses,
    ]);
    yield* runGitHubStackAction(api.execute, { ...input, action: "update-branch" });
    expect(gitCalls.filter((args) => args[0] === "push")).toHaveLength(2);
  }),
);

it.effect("bounds polling and reports a still-running merge without claiming success", () =>
  Effect.gen(function* () {
    const api = fake([
      stack,
      ...Array.from({ length: 40 }, () => ({ status: "pending", details: { uuid: "operation" } })),
    ]);
    const fiber = yield* runGitHubStackAction(api.execute, input).pipe(
      Effect.result,
      Effect.forkChild,
    );
    yield* TestClock.adjust("6 minutes");
    expect(yield* Fiber.join(fiber)).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "GitHubStackMergePendingError" },
    });
    expect(api.calls.length).toBeLessThan(40);
  }),
);

it.effect("rebases the open layers bottom to top in a scratch clone, each onto the one below", () =>
  Effect.gen(function* () {
    gitCalls = [];
    const api = fake([stack, access]);
    yield* runGitHubStackAction(api.execute, { ...input, action: "update-branch" });
    // GitHub is only read; every change is a git push with a lease on the reviewed head.
    expect(api.calls.some(isMutation)).toBe(false);
    const rebases = gitCalls.filter((args) => args[0] === "rebase");
    expect(rebases).toEqual([
      ["rebase", "--quiet", "--onto", "origin/main", "new-sha"],
      ["rebase", "--quiet", "--onto", "new-sha", "bbb"],
    ]);
    expect(gitCalls.filter((args) => args[0] === "push")).toEqual([
      [
        "push",
        "--quiet",
        "--force-with-lease=refs/heads/middle:bbb",
        "origin",
        "new-sha:refs/heads/middle",
      ],
      [
        "push",
        "--quiet",
        "--force-with-lease=refs/heads/top:ccc",
        "origin",
        "new-sha:refs/heads/top",
      ],
    ]);
  }),
);

it.effect("checks every layer's write access before any git runs", () =>
  Effect.gen(function* () {
    gitCalls = [];
    const api = fake([
      stack,
      {
        data: {
          repository: {
            ...access.data.repository,
            pr3: { headRepository: { viewerPermission: "READ" }, maintainerCanModify: false },
          },
        },
      },
    ]);
    yield* Effect.flip(runGitHubStackAction(api.execute, { ...input, action: "update-branch" }));
    expect(gitCalls).toEqual([]);
  }),
);
