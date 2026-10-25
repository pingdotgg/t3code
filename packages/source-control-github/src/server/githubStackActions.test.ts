import { expect, it } from "@effect/vitest";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as GitHubRest from "./GitHubRest.ts";
import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubQuota from "./GitHubQuota.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import { runGitHubStackAction as runStackAction } from "./githubStackActions.ts";

type Call = ReadonlyArray<string>;
type Send = (call: Call, kind: "graphql" | "rest") => Effect.Effect<unknown>;

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

const graphQlHttp = (send: Send) =>
  HttpClient.make((request) =>
    Effect.gen(function* () {
      const sent =
        request.body._tag === "Uint8Array"
          ? (JSON.parse(new TextDecoder().decode(request.body.body)) as {
              readonly query: string;
              readonly variables: Readonly<Record<string, unknown>>;
            })
          : { query: "", variables: {} };
      const data = yield* send(words(sent.query, sent.variables), "graphql");
      return HttpClientResponse.fromWeb(
        request,
        new Response(encodeJson({ data }), { headers: { "content-type": "application/json" } }),
      );
    }),
  );

const runGitHubStackAction = (send: Send, input: Parameters<typeof runStackAction>[0]) =>
  runStackAction(input).pipe(
    Effect.provide(
      Layer.mergeAll(
        fakeGit,
        Layer.mock(GitHubRest.GitHubRest)({
          credential: () => Effect.succeed({ token: Redacted.make("token"), fingerprint: "fp" }),
          rest: (request) =>
            send(words(request.path, request.body), "rest").pipe(
              Effect.map((body) => ({
                status: 200,
                headers: {},
                body: encodeJson(body),
                truncated: false,
                invalidUtf8: false,
              })),
            ),
        }),
        GitHubRequestPolicy.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(GitHubCredentials.GitHubCredentials, {
                get: (host) =>
                  Effect.succeed({
                    host,
                    token: Redacted.make("token"),
                    source: "gh" as const,
                    fingerprint: "fp",
                  }),
                invalidate: () => Effect.void,
              }),
              GitHubQuota.layer,
              SourceControlRateLimit.layer,
            ),
          ),
        ),
        Layer.succeed(HttpClient.HttpClient, graphQlHttp(send)),
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
const writable = { headRepository: { viewerPermission: "WRITE" }, maintainerCanModify: false };
const accessOf = (...pullRequests: ReadonlyArray<unknown>) =>
  Object.fromEntries(
    pullRequests.map((pullRequest, index) => [`_${index}_repository`, { pullRequest }]),
  );
const access = accessOf(writable, writable);

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
      return value;
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

it.effect("refuses the entire rebase before mutation when a later fork denies write access", () =>
  Effect.gen(function* () {
    const api = fake([
      stack,
      accessOf(writable, {
        headRepository: { viewerPermission: "READ" },
        maintainerCanModify: false,
      }),
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
      accessOf(writable, {
        headRepository: { viewerPermission: "READ" },
        maintainerCanModify: true,
      }),
      ...rebaseResponses,
    ]);
    yield* runGitHubStackAction(api.execute, { ...input, action: "update-branch" });
    expect(gitCalls.filter((args) => args[0] === "push")).toHaveLength(2);
  }),
);

it.effect("rebases for a GitHub App, which GitHub gives no permission to read", () =>
  Effect.gen(function* () {
    gitCalls = [];
    const api = fake([
      stack,
      accessOf(
        { headRepository: { viewerPermission: null }, maintainerCanModify: false },
        { headRepository: { viewerPermission: null }, maintainerCanModify: false },
      ),
      ...rebaseResponses,
    ]);
    yield* runGitHubStackAction(api.execute, { ...input, action: "update-branch" });
    expect(gitCalls.filter((args) => args[0] === "push")).toHaveLength(2);
  }),
);

it.effect("rebases the open layers bottom to top in a scratch clone, each onto the one below", () =>
  Effect.gen(function* () {
    gitCalls = [];
    const api = fake([stack, access]);
    yield* runGitHubStackAction(api.execute, { ...input, action: "update-branch" });
    expect(api.calls[1]).toEqual(
      expect.arrayContaining(["_0_number=2", "_1_number=3", "_0_owner=acme", "_0_name=web"]),
    );
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
