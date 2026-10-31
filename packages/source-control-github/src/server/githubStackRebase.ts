import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Base64 from "effect/encoding/Base64";

import * as GitHubAppAccess from "./GitHubAppAccess.ts";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";

export interface CascadeLayer {
  readonly number: number;
  readonly headBranch: string;
  readonly headSha: string;
}

export class GitHubStackRebaseConflictError extends Schema.TaggedError<GitHubStackRebaseConflictError>()(
  "GitHubStackRebaseConflictError",
  { number: Schema.Int, completed: Schema.Int },
) {
  override get message(): string {
    return `PR #${this.number} conflicts with the layer below it. ${this.completed} layers were rebased; resolve #${this.number} with \`gh stack rebase\` and push.`;
  }
}

export class GitHubStackRebaseGitError extends Schema.TaggedError<GitHubStackRebaseGitError>()(
  "GitHubStackRebaseGitError",
  { step: Schema.String, number: Schema.Int, completed: Schema.Int, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Stack rebase stopped at PR #${this.number} while ${this.step}. ${this.completed} layers were rebased.`;
  }
}

function remoteUrl(host: string, repository: string): string {
  return `https://${host.trim().toLowerCase()}/${repository}.git`;
}

export const cascadeRebaseStack = Effect.fn("cascadeRebaseStack")(function* (input: {
  readonly host: string;
  readonly repository: string;
  readonly base: string;
  readonly layers: ReadonlyArray<CascadeLayer>;
  readonly remote?: string;
}) {
  const appAccess = yield* GitHubAppAccess.GitHubAppAccess;
  const { process } = yield* SourceControlHost.SourceControlHost;
  const fileSystem = yield* FileSystem.FileSystem;
  // A push takes one credential up front, so it must be one that reaches the repository.
  const { token } = yield* appAccess.credentialFor(input.host, input.repository);
  const first = input.layers[0];
  if (first === undefined) return 0;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-stack-rebase-" }).pipe(
    Effect.mapError(
      (cause) =>
        new GitHubStackRebaseGitError({
          step: "preparing",
          number: first.number,
          completed: 0,
          cause,
        }),
    ),
  );
  // Keep the token in this process's header, outside URLs, argv and git config.
  const remote = input.remote ?? remoteUrl(input.host, input.repository);
  const authorization = `AUTHORIZATION: basic ${Base64.encode(`x-access-token:${Redacted.value(token)}`)}`;
  const env = {
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: `http.${remote}.extraheader`,
    GIT_CONFIG_VALUE_0: authorization,
    GIT_CONFIG_KEY_1: "user.name",
    GIT_CONFIG_VALUE_1: "T3 Code",
    GIT_CONFIG_KEY_2: "user.email",
    GIT_CONFIG_VALUE_2: "noreply@t3.codes",
  };
  const git = (args: ReadonlyArray<string>, allowNonZeroExit = false) =>
    process.run({
      operation: "cascadeRebaseStack",
      command: "git",
      args,
      cwd: directory,
      env,
      timeoutMs: 120_000,
      ...(allowNonZeroExit ? { allowNonZeroExit: true } : {}),
    });
  const failed = (step: string, number: number, completed: number) => (cause: unknown) =>
    new GitHubStackRebaseGitError({ step, number, completed, cause });

  yield* git(["init", "--quiet"]).pipe(Effect.mapError(failed("preparing", first.number, 0)));
  yield* git(["remote", "add", "origin", remote]).pipe(
    Effect.mapError(failed("preparing", first.number, 0)),
  );
  yield* git([
    "fetch",
    "--quiet",
    "--no-tags",
    "origin",
    `+refs/heads/${input.base}:refs/remotes/origin/${input.base}`,
    ...input.layers.map(
      (layer) => `+refs/heads/${layer.headBranch}:refs/remotes/origin/${layer.headBranch}`,
    ),
  ]).pipe(Effect.mapError(failed("fetching", first.number, 0)));

  let parentOld = `origin/${input.base}`;
  let parentNew = `origin/${input.base}`;
  for (const [index, layer] of input.layers.entries()) {
    // Exclude old parents: the base fork point for the bottom, the reviewed lower head above it.
    const upstream =
      index === 0
        ? (yield* git(["merge-base", parentOld, layer.headSha]).pipe(
            Effect.mapError(failed("reading the fork point", layer.number, index)),
          )).stdout.trim()
        : parentOld;
    yield* git(["checkout", "--quiet", "--detach", layer.headSha]).pipe(
      Effect.mapError(failed("checking out", layer.number, index)),
    );
    const rebase = yield* git(["rebase", "--quiet", "--onto", parentNew, upstream], true).pipe(
      Effect.mapError(failed("rebasing", layer.number, index)),
    );
    if (rebase.exitCode !== 0) {
      yield* git(["rebase", "--abort"], true).pipe(Effect.ignore);
      return yield* new GitHubStackRebaseConflictError({ number: layer.number, completed: index });
    }
    const rebased = (yield* git(["rev-parse", "HEAD"]).pipe(
      Effect.mapError(failed("rebasing", layer.number, index)),
    )).stdout.trim();
    if (rebased !== layer.headSha) {
      yield* git([
        "push",
        "--quiet",
        `--force-with-lease=refs/heads/${layer.headBranch}:${layer.headSha}`,
        "origin",
        `${rebased}:refs/heads/${layer.headBranch}`,
      ]).pipe(Effect.mapError(failed("pushing", layer.number, index)));
    }
    parentOld = layer.headSha;
    parentNew = rebased;
  }
  return input.layers.length;
}, Effect.scoped);
