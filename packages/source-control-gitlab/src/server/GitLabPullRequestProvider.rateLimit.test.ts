import { VcsProcessExitError } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as GitLabCli from "./GitLabCli.ts";
import * as GitLabPullRequestCli from "./GitLabPullRequestCli.ts";
import * as GitLabPullRequestProvider from "./GitLabPullRequestProvider.ts";

it.effect("reports activity as rate limited when only the reactions endpoint is", () =>
  Effect.gen(function* () {
    const provider = yield* GitLabPullRequestProvider.make.pipe(
      Effect.provide(
        GitLabPullRequestCli.layer.pipe(
          Layer.provide(GitLabCli.layer),
          Layer.provide(
            TestSourceControlHost.layer({
              process: {
                run: (input) =>
                  input.args[1] === "graphql"
                    ? Effect.fail(
                        new VcsProcessExitError({
                          operation: input.operation,
                          command: input.command,
                          cwd: input.cwd,
                          exitCode: 1,
                          detail: "API rate limit exceeded.",
                          failureKind: "rate-limited",
                        }),
                      )
                    : Effect.succeed(TestSourceControlHost.processOutput("[]")),
              },
            }),
          ),
        ),
      ),
    );
    const reference = {
      cwd: "/repo",
      repository: "acme/web",
      host: "gitlab.example.test",
      number: 1,
    };

    expect(yield* Effect.result(provider.getChangeRequestActivity(reference))).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "PullRequestProviderError",
        reason: "rate-limited",
        cause: { _tag: "GitLabCliRateLimitError" },
      },
    });
  }),
);
