import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { GitHubCli } from "../git/Services/GitHubCli.ts";
import * as GitHubPullRequestCli from "./GitHubPullRequestCli.ts";

it.effect("gets the viewer from the requested GitHub host", () =>
  Effect.gen(function* () {
    const commands: Array<ReadonlyArray<string>> = [];
    const cli = yield* GitHubPullRequestCli.make.pipe(
      Effect.provide(
        Layer.mock(GitHubCli)({
          execute: (input) =>
            Effect.sync(() => {
              commands.push(input.args);
              return {
                stdout: "enterprise-user\n",
                stderr: "",
                code: 0,
                signal: null,
                timedOut: false,
                stdoutTruncated: false,
              };
            }),
        }),
      ),
    );

    const viewer = yield* cli.getViewerLogin({
      cwd: "/workspace/enterprise",
      host: "github.example.test",
    });

    assert.strictEqual(viewer, "enterprise-user");
    assert.deepStrictEqual(commands, [
      ["api", "--hostname", "github.example.test", "user", "--jq", ".login"],
    ]);
  }),
);
