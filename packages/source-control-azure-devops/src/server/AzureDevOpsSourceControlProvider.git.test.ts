// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { GitCommandError } from "@t3tools/contracts";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import * as AzureDevOpsSourceControlProvider from "./AzureDevOpsSourceControlProvider.ts";

const withRepository = <A, E>(
  test: (input: {
    readonly cwd: string;
    readonly git: (...args: string[]) => Effect.Effect<string, GitCommandError>;
    readonly write: (path: string, contents: string) => Effect.Effect<void>;
    readonly commit: Effect.Effect<void, GitCommandError>;
    readonly readTemplate: (treeish?: string) => Effect.Effect<Option.Option<string>>;
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const host = yield* SourceControlHost.SourceControlHost;
    const cwd = yield* Effect.acquireRelease(
      Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-azure-template-"))),
      (directory) => Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
    );
    const git = (...args: string[]) =>
      host.git
        .execute({ operation: "AzureDevOpsTemplate.test", cwd, args })
        .pipe(Effect.map((result) => result.stdout.trim()));
    const write = (path: string, contents: string) =>
      Effect.sync(() => {
        NodeFS.mkdirSync(NodePath.dirname(NodePath.join(cwd, path)), { recursive: true });
        NodeFS.writeFileSync(NodePath.join(cwd, path), contents);
      });
    const commit = Effect.gen(function* () {
      yield* git("add", "-A");
      yield* git("commit", "--allow-empty", "-m", "Add pull request templates");
    });
    yield* git("init", "--initial-branch=main");
    yield* git("config", "user.email", "test@example.com");
    yield* git("config", "user.name", "Test User");
    yield* git("config", "core.autocrlf", "false");
    yield* git("remote", "add", "origin", cwd);
    const provider = yield* AzureDevOpsSourceControlProvider.make.pipe(
      Effect.provide(Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({})),
    );
    return yield* test({
      cwd,
      git,
      write,
      commit,
      readTemplate: (treeish = "main") => provider.readChangeRequestTemplate!({ cwd, treeish }),
    });
  }).pipe(
    Effect.scoped,
    Effect.provide(
      TestSourceControlHost.layerWithRealGit({
        git: { resolvePrimaryRemoteName: () => Effect.succeed("origin") },
      }),
    ),
  );

const publishMain = (git: (...args: string[]) => Effect.Effect<string, GitCommandError>) =>
  Effect.gen(function* () {
    yield* git("update-ref", "refs/remotes/origin/main", "main");
    yield* git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  });

it.effect("reads the default-branch template whatever branch the pull request targets", () =>
  withRepository(({ git, write, commit, readTemplate }) =>
    Effect.gen(function* () {
      const templatePath = ".azuredevops/pull_request_template.md";
      yield* write(templatePath, "Default branch template");
      yield* commit;
      yield* publishMain(git);
      yield* git("checkout", "-b", "release");
      yield* write(templatePath, "Release branch template");
      yield* commit;
      yield* write(templatePath, "Uncommitted template");

      assert.deepStrictEqual(
        yield* readTemplate("release"),
        Option.some("Default branch template"),
      );
    }),
  ),
);

// Microsoft searches these locations in order; extension choice must not override folder precedence.
it.effect.each([
  [".azuredevops/pull_request_template.txt", ".vsts/pull_request_template.md"],
  [".vsts/pull_request_template.txt", "docs/pull_request_template.md"],
  ["docs/pull_request_template.txt", "pull_request_template.md"],
] as const)("prefers %s over %s", ([preferred, fallback]) =>
  withRepository(({ git, write, commit, readTemplate }) =>
    Effect.gen(function* () {
      yield* write(preferred, "Preferred template");
      yield* write(fallback, "Fallback template");
      yield* commit;
      yield* publishMain(git);

      assert.deepStrictEqual(yield* readTemplate(), Option.some("Preferred template"));
    }),
  ),
);

it.effect.each([
  ".AzUrEdEvOpS/PuLl_ReQuEsT_TeMpLaTe.MD",
  ".VsTs/PULL_REQUEST_TEMPLATE.TxT",
  "DoCs/Pull_Request_Template.mD",
  "PULL_REQUEST_TEMPLATE.TXT",
])("recognizes case-insensitive Azure template path %s", (templatePath) =>
  withRepository(({ git, write, commit, readTemplate }) =>
    Effect.gen(function* () {
      yield* write(templatePath, "Case-insensitive template");
      yield* commit;
      yield* publishMain(git);

      assert.deepStrictEqual(yield* readTemplate(), Option.some("Case-insensitive template"));
    }),
  ),
);

it.effect("ignores missing, blank, symlinked, and nested templates", () =>
  withRepository(({ cwd, git, write, commit, readTemplate }) =>
    Effect.gen(function* () {
      yield* commit;
      yield* publishMain(git);
      assert.deepStrictEqual(yield* readTemplate(), Option.none());

      yield* write(".azuredevops/pull_request_template.md", " \n\t ");
      yield* commit;
      yield* publishMain(git);
      assert.deepStrictEqual(yield* readTemplate(), Option.none());

      yield* git("rm", "-q", ".azuredevops/pull_request_template.md");
      yield* write("template.md", "Not a default template");
      yield* Effect.sync(() => {
        NodeFS.mkdirSync(NodePath.join(cwd, ".azuredevops"), { recursive: true });
        NodeFS.symlinkSync(
          NodePath.join(cwd, "template.md"),
          NodePath.join(cwd, ".azuredevops/pull_request_template.md"),
        );
      });
      yield* write("docs/nested/pull_request_template.md", "Nested template");
      yield* commit;
      yield* publishMain(git);
      assert.deepStrictEqual(yield* readTemplate(), Option.none());
    }),
  ),
);

it.effect("bounds template content and marks truncation", () =>
  withRepository(({ git, write, commit, readTemplate }) =>
    Effect.gen(function* () {
      yield* write("pull_request_template.md", "x".repeat(10_000));
      yield* commit;
      yield* publishMain(git);

      const template = yield* readTemplate();
      assert.isTrue(Option.isSome(template));
      if (Option.isSome(template)) {
        assert.isTrue(template.value.startsWith("x".repeat(8_000)));
        assert.isTrue(template.value.endsWith("[truncated]"));
        assert.isBelow(template.value.length, 8_100);
      }
    }),
  ),
);

it.effect("returns no template when the local remote default branch is unknown", () =>
  withRepository(({ write, commit, readTemplate }) =>
    Effect.gen(function* () {
      yield* write("pull_request_template.md", "Target branch template");
      yield* commit;

      assert.deepStrictEqual(yield* readTemplate(), Option.none());
    }),
  ),
);
