// @effect-diagnostics preferSchemaOverJson:off effectFnOpportunity:off
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as ForgejoCli from "./ForgejoCli.ts";
import * as ForgejoPullRequestProvider from "./ForgejoPullRequestProvider.ts";
import * as ForgejoSourceControlProvider from "./ForgejoSourceControlProvider.ts";
import { markRequiredForgejoChecks } from "./forgejoRequiredChecks.ts";

export const processOutput = TestSourceControlHost.processOutput;

export const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

export const requestJson = (request: HttpClientRequest.HttpClientRequest): unknown => {
  assert.strictEqual(request.body._tag, "Uint8Array");
  return request.body._tag === "Uint8Array"
    ? decodeJson(new TextDecoder().decode(request.body.body))
    : undefined;
};

export const encodeJsonEffect = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

it.effect("reads clone URLs on the given host rather than the checkout's", () => {
  const urls: string[] = [];
  const client = HttpClient.make((request) => {
    urls.push(request.url);
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(
          encodeJson({
            full_name: "maria/project",
            clone_url: "https://forgejo.test/maria/project.git",
            ssh_url: "git@forgejo.test:maria/project.git",
          }),
        ),
      ),
    );
  });
  return Effect.gen(function* () {
    const cli = yield* ForgejoCli.make;
    const provider = yield* ForgejoSourceControlProvider.make.pipe(
      Effect.provideService(ForgejoCli.ForgejoCli, cli),
    );
    const cloneUrls = yield* provider.getRepositoryCloneUrls({
      cwd: "/repo",
      repository: "maria/project",
      host: "forgejo.test",
    });
    assert.strictEqual(cloneUrls.url, "https://forgejo.test/maria/project.git");
    assert.deepStrictEqual(urls, ["https://forgejo.test/api/v1/repos/maria/project"]);
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, client),
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        exists: () => Effect.succeed(true),
        readFileString: () =>
          Effect.succeed(
            encodeJson({
              hosts: {
                "forgejo.test": { type: "Application", token: "test-token" },
                "code.example": { type: "Application", token: "other-token" },
              },
            }),
          ),
      }),
    ),
    Effect.provide(
      TestSourceControlHost.layer({
        process: {
          run: (input) => {
            if (input.command === "git") {
              assert.deepStrictEqual(input.args, ["remote", "-v"]);
              // The checkout is on another Forgejo server with a same-named repository.
              return Effect.succeed(
                processOutput("origin\thttps://code.example/maria/project.git (fetch)"),
              );
            }
            assert.strictEqual(input.command, "fj");
            assert.deepStrictEqual(input.args, ["--host", "https://forgejo.test", "whoami"]);
            return Effect.succeed(processOutput(""));
          },
        },
      }),
    ),
  );
});

export const requiredChecksPullRequest = {
  number: 7,
  title: "Required checks",
  body: "",
  html_url: "https://forgejo.test/acme/web/pulls/7",
  user: { login: "maria" },
  state: "open",
  merged: false,
  head: { ref: "feature", sha: "head", repo: null },
  base: { ref: "release/1.x", sha: "base", repo: null },
  created_at: "2026-10-12T00:00:00Z",
  updated_at: "2026-10-12T00:00:00Z",
  closed_at: null,
  merged_at: null,
  labels: [],
};

const requiredChecksStatuses = [
  ["ci/required-build", "success"],
  ["ci/optional-lint", "failure"],
].map(([context, status]) => ({
  context,
  status,
  description: null,
  target_url: null,
  updated_at: "2026-10-12T00:00:00Z",
}));

export const requiredChecksInput = {
  cwd: "/repo",
  repository: "acme/web",
  host: "forgejo.test",
  number: 7,
};

const requiredChecksLayer = (
  branch: Effect.Effect<unknown, ForgejoCli.ForgejoCliError>,
  statuses = requiredChecksStatuses,
) =>
  Layer.mock(ForgejoCli.ForgejoCli)({
    api: (input) => {
      const [path, query] = input.path.split("?");
      const respond = (response: unknown) =>
        encodeJsonEffect(response).pipe(Effect.orDie, Effect.map(processOutput));
      switch (path) {
        case "repos/acme/web/pulls/7":
          return respond(requiredChecksPullRequest);
        case "repos/acme/web/statuses/head":
          return respond(new URLSearchParams(query).get("page") === "1" ? statuses : []);
        case "repos/acme/web/branches/release/1.x":
          return Effect.flatMap(branch, respond);
        case "repos/acme/web":
          return respond({ full_name: "acme/web", permissions: { push: true, admin: false } });
        case "user":
          return respond({ login: "maria" });
        default:
          return Effect.die(`Unexpected Forgejo request: ${input.path}`);
      }
    },
  });

it.effect.each([
  ["ci/required-deploy", true],
  ["test-*", true],
  ["ci/[ab]", false],
] as const)("keeps missing required pattern %s pending (supported: %s)", ([missing, supported]) =>
  Effect.gen(function* () {
    const provider = yield* ForgejoPullRequestProvider.make;
    const readChecks = provider.getChangeRequestChecks;
    if (readChecks === undefined) return yield* Effect.die("checks read missing");
    const summary = yield* readChecks(requiredChecksInput);
    const detail = yield* provider.getChangeRequest(requiredChecksInput);
    for (const checks of [summary.checks, detail.checks]) {
      assert.deepStrictEqual(
        checks.map((check) => [check.name, check.status, check.required]),
        supported
          ? [
              ["ci/optional-lint", "failure", undefined],
              ["ci/required-build", "success", true],
              [missing, "pending", true],
            ]
          : [
              ["ci/required-build", "success", undefined],
              ["ci/optional-lint", "success", undefined],
              [missing, "pending", undefined],
            ],
      );
      if (!supported) {
        assert.strictEqual(
          checks.at(-1)?.description,
          "Required check pattern cannot be evaluated.",
        );
      }
    }
  }).pipe(
    Effect.provide(
      requiredChecksLayer(
        Effect.succeed({
          name: "release/1.x",
          protected: true,
          enable_status_check: true,
          status_check_contexts: ["ci/required-*", missing, missing],
        }),
        supported
          ? requiredChecksStatuses
          : requiredChecksStatuses.map((status) => ({ ...status, status: "success" })),
      ),
    ),
  ),
);

it("matches many-wildcard required patterns against long check names without backtracking", () => {
  const checks = ["a".repeat(200), `${"a".repeat(199)}b`, "x?y\nz"].map((name) => ({
    name,
    status: "success" as const,
    description: null,
    url: null,
  }));
  const marked = markRequiredForgejoChecks(checks, {
    enable_status_check: true,
    status_check_contexts: [`${"*a".repeat(12)}b`, "x*?y?z"],
  });
  assert.deepStrictEqual(
    marked.map((check) => [check.name.slice(-3), check.required]),
    [
      ["aaa", undefined],
      ["aab", true],
      ["y\nz", true],
    ],
  );
});

it("treats a required pattern's `*` as a wildcard even when the check name has one", () => {
  const checks = ["*build", "ci/*lint"].map((name) => ({
    name,
    status: "success" as const,
    description: null,
    url: null,
  }));
  const marked = markRequiredForgejoChecks(checks, {
    enable_status_check: true,
    status_check_contexts: ["*build", "ci/*"],
  });
  assert.deepStrictEqual(
    marked.map((check) => [check.name, check.required]),
    [
      ["*build", true],
      ["ci/*lint", true],
    ],
  );
});

const tiedStatuses = [
  { id: 15, status: "success" },
  { id: 14, status: "pending" },
].map(({ id, status }) => ({
  id,
  context: "ci/required-build",
  status,
  description: null,
  target_url: null,
  updated_at: "2026-10-12T10:14:29Z",
}));

it.effect.each([
  ["newest first", tiedStatuses],
  ["oldest first", tiedStatuses.toReversed()],
] as const)("reads the status created last when two share a second, listed %s", ([, statuses]) =>
  Effect.gen(function* () {
    const provider = yield* ForgejoPullRequestProvider.make;
    const readChecks = provider.getChangeRequestChecks;
    if (readChecks === undefined) return yield* Effect.die("checks read missing");
    const summary = yield* readChecks(requiredChecksInput);
    const detail = yield* provider.getChangeRequest(requiredChecksInput);
    for (const checks of [summary.checks, detail.checks]) {
      assert.deepStrictEqual(
        checks.map((check) => [check.name, check.status]),
        [["ci/required-build", "success"]],
      );
    }
  }).pipe(Effect.provide(requiredChecksLayer(Effect.succeed({}), statuses))),
);

const forgejoMergeProvider = (repository: Effect.Effect<string, ForgejoCli.ForgejoCliError>) => {
  const writes: Array<ForgejoCli.ForgejoApiInput> = [];
  const provider = ForgejoPullRequestProvider.make.pipe(
    Effect.provide(
      Layer.mock(ForgejoCli.ForgejoCli)({
        api: (input) => {
          if (input.method !== undefined && input.method !== "GET") writes.push(input);
          return (input.path === "repos/reviewer/project" ? repository : Effect.succeed("")).pipe(
            Effect.map((stdout) => ({
              exitCode: ChildProcessSpawner.ExitCode(0),
              stdout,
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            })),
          );
        },
      }),
    ),
  );
  return { provider, writes };
};

const forgejoMergeInput = {
  cwd: "/forgejo",
  repository: "reviewer/project",
  host: "forge.example:3000",
  number: 1,
  action: "merge",
  mergeMethod: "squash",
} as const;

it.effect("follows the Forgejo repository's delete-branch-after-merge setting", () =>
  Effect.gen(function* () {
    for (const [setting, deleteBranch] of [
      [{ default_delete_branch_after_merge: true }, true],
      [{ default_delete_branch_after_merge: false }, false],
      [{}, false],
    ] as const) {
      const { provider, writes } = forgejoMergeProvider(
        Effect.succeed(JSON.stringify({ full_name: "reviewer/project", ...setting })),
      );
      yield* (yield* provider).runAction(forgejoMergeInput);
      assert.deepStrictEqual(
        writes.map((write) => [write.path, write.body]),
        [
          [
            "repos/reviewer/project/pulls/1/merge",
            { Do: "squash", delete_branch_after_merge: deleteBranch },
          ],
        ],
        `repository setting ${JSON.stringify(setting)}`,
      );
    }
  }),
);

it.effect("does not merge on Forgejo when the repository settings cannot be read", () =>
  Effect.gen(function* () {
    const { provider, writes } = forgejoMergeProvider(
      Effect.fail(
        new ForgejoCli.ForgejoCliError({
          command: "tea",
          cwd: "/forgejo",
          detail: "Forgejo is unavailable.",
        }),
      ),
    );
    const exit = yield* Effect.exit((yield* provider).runAction(forgejoMergeInput));
    assert.deepStrictEqual(
      writes.map((write) => write.path),
      [],
      "merged without knowing whether to delete the source branch",
    );
    assert.isTrue(Exit.isFailure(exit));
  }),
);

it.effect.each([
  [true, false],
  [false, true],
] as const)(
  "reports a Forgejo merge whose branch deletion was refused by whether it merged (merged: %s)",
  ([merged, fails]) => {
    const refused = new ForgejoCli.ForgejoCliError({
      command: "fj",
      cwd: "/repo",
      detail: "branch is protected",
      httpStatus: 403,
      reason: "forbidden",
    });
    return Effect.gen(function* () {
      const provider = yield* ForgejoPullRequestProvider.make;
      const exit = yield* Effect.exit(
        provider.runAction({ ...requiredChecksInput, action: "merge", mergeMethod: "merge" }),
      );
      assert.strictEqual(exit._tag === "Failure", fails);
    }).pipe(
      Effect.provide(
        Layer.mock(ForgejoCli.ForgejoCli)({
          api: (input) => {
            const respond = (response: unknown) =>
              encodeJsonEffect(response).pipe(Effect.orDie, Effect.map(processOutput));
            switch (input.path) {
              case "repos/acme/web":
                return respond({ full_name: "acme/web", default_delete_branch_after_merge: true });
              case "repos/acme/web/pulls/7/merge":
                return Effect.fail(refused);
              case "repos/acme/web/pulls/7":
                return respond({ ...requiredChecksPullRequest, merged });
              default:
                return Effect.die(`Unexpected Forgejo request: ${input.path}`);
            }
          },
        }),
      ),
    );
  },
);

// regression: #18775 a failed branch-protection read surfaces; only 403/404 are treated as no policy
it.effect.each([
  ["rate limit", { reason: "rate-limit", httpStatus: 429 }, "rate-limited"],
  ["authentication failure", { reason: "authentication", httpStatus: 401 }, "unauthenticated"],
  ["network failure", {}, "failed"],
] as const)("propagates branch metadata %s", ([detail, fields, reason]) => {
  const cause = new ForgejoCli.ForgejoCliError({ command: "fj", cwd: "/repo", detail, ...fields });
  return Effect.gen(function* () {
    const provider = yield* ForgejoPullRequestProvider.make;
    const readChecks = provider.getChangeRequestChecks;
    if (readChecks === undefined) return yield* Effect.die("checks read missing");
    for (const read of [readChecks, provider.getChangeRequest]) {
      const error = yield* read(requiredChecksInput).pipe(Effect.flip);
      assert.strictEqual(error.reason, reason);
      assert.strictEqual(error.cause, cause);
    }
  }).pipe(Effect.provide(requiredChecksLayer(Effect.fail(cause))));
});
