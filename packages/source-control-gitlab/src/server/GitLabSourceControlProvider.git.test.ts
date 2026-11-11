// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { GitCommandError } from "@t3tools/contracts";

import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as GitLabCli from "./GitLabCli.ts";
import * as GitLabSourceControlProvider from "./GitLabSourceControlProvider.ts";

it.effect("lists a nested-group fork's merge requests by source branch and names its project", () =>
  Effect.gen(function* () {
    const branch = "feature/NestedGroups";
    const output = JSON.stringify([
      {
        iid: 2,
        title: "Another subgroup's fork",
        web_url: "https://gitlab.com/Group/Upstream/Repository/-/merge_requests/2",
        target_branch: "main",
        source_branch: branch,
        state: "opened",
        updated_at: "2026-04-08T15:00:00Z",
        source_project_id: 102,
        target_project_id: 100,
        source_project: { path_with_namespace: "Group/Other/Fork" },
      },
      {
        iid: 1,
        title: "This subgroup's fork",
        web_url: "https://gitlab.com/Group/Upstream/Repository/-/merge_requests/1",
        target_branch: "main",
        source_branch: branch,
        state: "opened",
        updated_at: "2026-04-07T15:00:00Z",
        source_project_id: 101,
        target_project_id: 100,
        source_project: { path_with_namespace: "Group/Subgroup/Fork" },
      },
    ]);
    const calls: SourceControlHost.SourceControlProcessInput[] = [];
    const provider = yield* GitLabSourceControlProvider.make.pipe(
      Effect.provide(
        GitLabCli.layer.pipe(
          Layer.provideMerge(
            TestSourceControlHost.layer({
              process: {
                run: (input) =>
                  Effect.sync(() => {
                    calls.push(input);
                    return TestSourceControlHost.processOutput(output);
                  }),
              },
            }),
          ),
        ),
      ),
    );

    for (const headSelector of [branch, `Group/Subgroup:${branch}`]) {
      const changeRequests = yield* provider.listChangeRequests({
        cwd: "/repo",
        headSelector,
        state: "all",
        limit: 20,
      });
      expect(changeRequests).toMatchObject([
        {
          number: 2,
          headRefName: branch,
          isCrossRepository: true,
          headRepositoryNameWithOwner: "Group/Other/Fork",
        },
        {
          number: 1,
          url: "https://gitlab.com/Group/Upstream/Repository/-/merge_requests/1",
          headRefName: branch,
          isCrossRepository: true,
          headRepositoryNameWithOwner: "Group/Subgroup/Fork",
        },
      ]);
    }
    assert.lengthOf(calls, 2);
    for (const call of calls) {
      expect(call.command).toBe("glab");
      expect(call.args).toEqual([
        "mr",
        "list",
        "--source-branch",
        branch,
        "--all",
        "--per-page",
        "20",
        "--output",
        "json",
      ]);
    }
  }),
);

const withRepository = <A, E>(
  test: (input: {
    readonly git: (...args: string[]) => Effect.Effect<string, GitCommandError>;
    readonly write: (path: string, contents: string) => Effect.Effect<void>;
    readonly readTemplate: (treeish?: string) => Effect.Effect<Option.Option<string>>;
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const host = yield* SourceControlHost.SourceControlHost;
    const cwd = yield* Effect.acquireRelease(
      Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-gitlab-template-"))),
      (directory) => Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
    );
    const git = (...args: string[]) =>
      host.git
        .execute({ operation: "GitLabTemplate.test", cwd, args })
        .pipe(Effect.map((result) => result.stdout.trim()));
    const write = (path: string, contents: string) =>
      Effect.sync(() => {
        NodeFS.mkdirSync(NodePath.dirname(NodePath.join(cwd, path)), { recursive: true });
        NodeFS.writeFileSync(NodePath.join(cwd, path), contents);
      });
    yield* git("init", "--initial-branch=main");
    yield* git("config", "user.email", "test@example.com");
    yield* git("config", "user.name", "Test User");
    yield* write("README.md", "hello\n");
    yield* git("add", "README.md");
    yield* git("commit", "-m", "Initial commit");
    const provider = yield* GitLabSourceControlProvider.make.pipe(
      Effect.provide(Layer.mock(GitLabCli.GitLabCli)({})),
    );
    return yield* test({
      git,
      write,
      readTemplate: (treeish = "HEAD") => provider.readChangeRequestTemplate!({ cwd, treeish }),
    });
  }).pipe(Effect.scoped, Effect.provide(TestSourceControlHost.layerWithRealGit()));

const DEFAULT_TEMPLATE = ".gitlab/merge_request_templates/Default.md";

it.effect("ignores unavailable or non-regular GitLab default templates", () =>
  withRepository(({ git, write, readTemplate }) =>
    Effect.gen(function* () {
      expect(yield* readTemplate()).toEqual(Option.none());

      yield* write(".gitlab/merge_request_templates/Bugfix.md", "Not the default");
      yield* git("add", ".gitlab");
      yield* git("commit", "-m", "Add a selectable template");
      expect(yield* readTemplate()).toEqual(Option.none());

      yield* write(DEFAULT_TEMPLATE, " \n\n");
      yield* git("add", ".gitlab");
      yield* git("commit", "-m", "Add a blank default");
      expect(yield* readTemplate()).toEqual(Option.none());

      // Index modes exercise committed symlinks and submodules even on hosts without symlinks.
      const blob = yield* git("rev-parse", "HEAD:README.md");
      yield* git("update-index", "--cacheinfo", "120000", blob, DEFAULT_TEMPLATE);
      yield* git("commit", "-m", "Replace default with a symlink");
      expect(yield* readTemplate()).toEqual(Option.none());

      const commit = yield* git("rev-parse", "HEAD");
      yield* git("update-index", "--cacheinfo", "160000", commit, DEFAULT_TEMPLATE);
      yield* git("commit", "-m", "Replace default with a submodule");
      expect(yield* readTemplate()).toEqual(Option.none());
      expect(yield* readTemplate("missing-base")).toEqual(Option.none());
    }),
  ),
);

it.effect("bounds GitLab template content and marks truncation", () =>
  withRepository(({ git, write, readTemplate }) =>
    Effect.gen(function* () {
      const prefix = "a".repeat(8_000);
      yield* write(DEFAULT_TEMPLATE, prefix + "EXCLUDED_SUFFIX");
      yield* git("add", ".gitlab");
      yield* git("commit", "-m", "Add a large template");

      expect(yield* readTemplate()).toEqual(Option.some(prefix + "\n\n[truncated]"));
    }),
  ),
);
