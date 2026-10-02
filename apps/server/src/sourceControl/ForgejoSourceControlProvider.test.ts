import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ForgejoCli from "./ForgejoCli.ts";
import * as ForgejoSourceControlProvider from "./ForgejoSourceControlProvider.ts";

const output = (stdout = "") => ({
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  exitCode: ChildProcessSpawner.ExitCode(0),
});

for (const scenario of [
  { url: "ext::echo blocked", allowed: false },
  { url: "file:///private/tmp/repo", allowed: false },
  { url: "/private/tmp/repo", allowed: false },
  { url: "--upload-pack=echo", allowed: false },
  { url: "git://forge.test/team/project.git", allowed: false },
  {
    url: "http://forge.test:3000/team/project.git",
    allowed: true,
    origin: "git@forge.test:team/base.git",
  },
  {
    url: "http://forge.test:3000/team/project.git",
    allowed: true,
    origin: "ssh://git@forge.test:2222/team/base.git",
  },
  { url: "http://other.test/team/project.git", allowed: false },
  { url: "http://forge.test:3001/team/project.git", allowed: true },
  { url: "http://forge.test:3000/team/project.git", allowed: true },
  { url: "https://forge.test/team/project.git", allowed: true },
  { url: "git@forge.test:team/project.git", allowed: true },
]) {
  it.effect(
    `Forgejo provider remote policy ${scenario.allowed ? "fetches" : "rejects"} ${scenario.url} with ${"origin" in scenario ? scenario.origin : "HTTP origin"}`,
    () =>
      Effect.gen(function* () {
        const calls: Array<ReadonlyArray<string>> = [];
        const provider = yield* ForgejoSourceControlProvider.make.pipe(
          Effect.provide(
            Layer.merge(
              Layer.mock(ForgejoCli.ForgejoCli)({
                resolveRepository: () =>
                  Effect.succeed({
                    command: "fj",
                    login: "test",
                    repository: "team/project",
                    baseUrl: "http://forge.test:3000",
                  }),
                api: (input) =>
                  Effect.succeed(
                    output(
                      JSON.stringify(
                        input.path.endsWith("/pulls/42")
                          ? {
                              number: 42,
                              title: "Test",
                              html_url: "http://forge.test:3000/team/project/pulls/42",
                              state: "open",
                              merged: false,
                              base: { ref: "main", sha: "base", repo: null },
                              head: { ref: "feature", sha: "head", repo: null },
                            }
                          : {
                              full_name: "team/project",
                              clone_url: scenario.url,
                              ssh_url: scenario.url,
                            },
                      ),
                    ),
                  ),
              }),
              Layer.mock(VcsProcess.VcsProcess)({
                run: (input) =>
                  Effect.sync(() => {
                    calls.push(input.args);
                    return output();
                  }),
              }),
            ),
          ),
        );
        const checkout = provider.checkoutChangeRequest({
          cwd: "/repo",
          reference: "42",
          context: {
            provider: { kind: "forgejo", name: "Forgejo", baseUrl: "http://forge.test:3000" },
            remoteName: "origin",
            remoteUrl:
              "origin" in scenario ? scenario.origin : "http://forge.test:3000/team/base.git",
          },
        });
        if (scenario.allowed) {
          yield* checkout;
          assert.deepStrictEqual(calls[0], ["fetch", "--", scenario.url, "refs/pull/42/head"]);
        } else {
          const error = yield* checkout.pipe(Effect.flip);
          assert.equal(error._tag, "SourceControlProviderError");
          assert.equal(error.operation, "checkoutChangeRequest");
          assert.equal(error.command, "git fetch");
          assert.include(error.detail, "Refusing to fetch a repository URL");
          assert.deepStrictEqual(calls, []);
        }
      }).pipe(Effect.provide(NodeServices.layer)),
  );
}
