import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as GitLabCli from "../sourceControl/GitLabCli.ts";
import * as GitLabIssueCli from "./GitLabIssueCli.ts";
import * as GitLabIssueProvider from "./GitLabIssueProvider.ts";

it.effect("maps CLI rate limits without changing other GitLab failures", () =>
  Effect.gen(function* () {
    const context = {
      operation: "execute" as const,
      command: "glab" as const,
      cwd: "/repo",
      cause: new Error("provider failure"),
    };
    for (const [source, reason] of [
      [new GitLabCli.GitLabCliRateLimitError(context), "rate-limited"],
      [new GitLabCli.GitLabCliUnavailableError(context), "missing-tool"],
      [new GitLabCli.GitLabCliAuthenticationError(context), "unauthenticated"],
      [new GitLabCli.GitLabCliCommandError(context), "failed"],
    ] as const) {
      const provider = yield* GitLabIssueProvider.make.pipe(
        Effect.provide(
          Layer.mock(GitLabIssueCli.GitLabIssueCli)({
            listIssues: () => Effect.fail(source),
            runIssueAction: () => Effect.fail(source),
          }),
        ),
      );
      const reference = { cwd: "/repo", repository: "acme/web", host: "gitlab.com" };
      for (const request of [
        provider.listIssues({
          ...reference,
          state: "open",
          involvement: "all",
          viewer: "ada",
          limit: 20,
        }),
        provider.runAction({ ...reference, number: 7, action: "close" }),
      ]) {
        const error = yield* Effect.flip(request);
        assert.strictEqual(error._tag, "IssueProviderError");
        assert.strictEqual(error.provider, "gitlab");
        assert.strictEqual(error.reason, reason);
        assert.strictEqual(error.retryAt, undefined);
        assert.strictEqual(error.detail, source.detail);
        assert.strictEqual(error.cause, source);
      }
    }
  }),
);
