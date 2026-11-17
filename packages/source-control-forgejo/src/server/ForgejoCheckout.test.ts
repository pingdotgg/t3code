import { SourceControlProviderKind } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import { processOutput } from "@t3tools/source-control-testing/TestSourceControlHost";

import * as ForgejoCli from "./ForgejoCli.ts";
import * as ForgejoSourceControlProvider from "./ForgejoSourceControlProvider.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it.effect(
  "checks out fj pull refs and preserves existing branches and dirty files until forced",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const git = (yield* SourceControlHost.SourceControlHost).process;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fj-checkout-" });
      const source = path.join(root, "source");
      const cwd = path.join(root, "checkout");
      yield* fs.makeDirectory(source);
      for (const args of [
        ["init", "-b", "main"],
        ["config", "user.name", "Test"],
        ["config", "user.email", "test@example.com"],
      ])
        yield* git.run({ operation: "test.setup", command: "git", cwd: source, args });
      yield* fs.writeFileString(path.join(source, "base.txt"), "base\n");
      for (const args of [
        ["add", "base.txt"],
        ["commit", "-m", "base"],
      ])
        yield* git.run({ operation: "test.setup", command: "git", cwd: source, args });
      const base = (yield* git.run({
        operation: "test.setup",
        command: "git",
        cwd: source,
        args: ["rev-parse", "HEAD"],
      })).stdout.trim();
      yield* git.run({
        operation: "test.setup",
        command: "git",
        cwd: root,
        args: ["clone", source, cwd],
      });
      yield* fs.writeFileString(path.join(source, "feature.txt"), "pull request change\n");
      for (const args of [
        ["add", "feature.txt"],
        ["commit", "-m", "feature"],
        ["update-ref", "refs/pull/42/head", "HEAD"],
      ])
        yield* git.run({ operation: "test.setup", command: "git", cwd: source, args });
      const head = (yield* git.run({
        operation: "test.setup",
        command: "git",
        cwd: source,
        args: ["rev-parse", "HEAD"],
      })).stdout.trim();
      const fetched: string[] = [];
      const provider = yield* ForgejoSourceControlProvider.make.pipe(
        Effect.provide(
          Layer.merge(
            TestSourceControlHost.layerWithRealGit({
              process: {
                run: (input) => {
                  if (input.args[0] !== "fetch") return git.run(input);
                  const url = input.args[2];
                  assert.isDefined(url);
                  fetched.push(url!);
                  return git.run({
                    ...input,
                    args: input.args.map((arg) =>
                      arg === "git@forgejo.test:reviewer/project.git" ? source : arg,
                    ),
                  });
                },
              },
            }),
            Layer.mock(ForgejoCli.ForgejoCli)({
              resolveRepository: () =>
                Effect.succeed({
                  command: "fj",
                  login: "work",
                  repository: "reviewer/project",
                  baseUrl: "https://forgejo.test",
                }),
              api: (input) => {
                assert.include(
                  ["repos/reviewer/project", "repos/reviewer/project/pulls/42"],
                  input.path,
                );
                return Effect.succeed(
                  processOutput(
                    encodeJson(
                      input.path.endsWith("/pulls/42")
                        ? {
                            number: 42,
                            title: "Checkout",
                            html_url: "https://forgejo.test/reviewer/project/pulls/42",
                            state: "open",
                            merged: false,
                            base: { ref: "main", sha: base, repo: null },
                            head: { ref: "feature", sha: head, repo: null },
                          }
                        : {
                            full_name: "reviewer/project",
                            clone_url: source,
                            ssh_url: "git@forgejo.test:reviewer/project.git",
                            default_branch: "main",
                          },
                    ),
                  ),
                );
              },
            }),
          ),
        ),
      );
      yield* provider.checkoutChangeRequest({
        cwd,
        reference: "https://forgejo.test/reviewer/project/pulls/42",
      });
      assert.strictEqual(
        (yield* git.run({
          operation: "test.verify",
          command: "git",
          cwd,
          args: ["branch", "--show-current"],
        })).stdout.trim(),
        "pulls/42",
      );
      assert.strictEqual(
        (yield* git.run({
          operation: "test.verify",
          command: "git",
          cwd,
          args: ["rev-parse", "HEAD"],
        })).stdout.trim(),
        head,
      );
      assert.strictEqual(
        yield* fs.readFileString(path.join(cwd, "feature.txt")),
        "pull request change\n",
      );
      for (const args of [
        ["checkout", "main"],
        ["branch", "-f", "pulls/42", "main"],
      ])
        yield* git.run({ operation: "test.setup", command: "git", cwd, args });
      yield* fs.writeFileString(path.join(cwd, "base.txt"), "uncommitted work\n");
      yield* provider.checkoutChangeRequest({ cwd, reference: "42" });
      assert.strictEqual(
        (yield* git.run({
          operation: "test.verify",
          command: "git",
          cwd,
          args: ["rev-parse", "HEAD"],
        })).stdout.trim(),
        base,
      );
      assert.strictEqual(yield* fs.exists(path.join(cwd, "feature.txt")), false);
      yield* provider.checkoutChangeRequest({
        cwd,
        reference: "42",
        force: true,
        context: {
          provider: {
            kind: SourceControlProviderKind.make("forgejo"),
            name: "Forgejo",
            baseUrl: "https://forgejo.test",
          },
          remoteName: "origin",
          remoteUrl: "git@forgejo.test:maria/project.git",
        },
      });
      assert.strictEqual(
        (yield* git.run({
          operation: "test.verify",
          command: "git",
          cwd,
          args: ["rev-parse", "HEAD"],
        })).stdout.trim(),
        head,
      );
      assert.strictEqual(
        yield* fs.readFileString(path.join(cwd, "base.txt")),
        "uncommitted work\n",
      );
      assert.strictEqual(
        yield* fs.readFileString(path.join(cwd, "feature.txt")),
        "pull request change\n",
      );
      assert.deepStrictEqual(fetched, [source, source, "git@forgejo.test:reviewer/project.git"]);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(TestSourceControlHost.layerWithRealGit(), NodeServices.layer)),
    ),
);
