import type { ProjectId, ServerSettings } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { readSourceControlHostSettings } from "@t3tools/source-control-core/shared/definition";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as GitHubClient from "@t3tools/source-control-github/shared/definition";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";

/**
 * Env overlay so agent `gh` in this project matches the project's GitHub account. Empty when no
 * project or environment host pin applies, or when `gh` cannot hand over that login's token.
 */
export const projectGitHubEnvironment = Effect.fn("projectGitHubEnvironment")(function* (
  settings: ServerSettings,
  projectId: ProjectId,
) {
  const pinned = resolveProjectSettings(settings, projectId).settings.githubHostAccounts[
    "github.com"
  ];
  const hostPin = readSourceControlHostSettings(
    GitHubClient.settings,
    settings.sourceControlHosts[GitHubClient.definition.kind],
  ).hosts["github.com"]?.account;
  const login = pinned ?? hostPin;
  if (login === undefined) return {} as NodeJS.ProcessEnv;
  const { process } = yield* SourceControlHost.SourceControlHost;
  const workingDirectory = yield* HostProcess.WorkingDirectory;
  return yield* process
    .run({
      operation: "projectGitHubEnvironment",
      command: "gh",
      args: ["auth", "token", "--hostname", "github.com", "--user", login],
      cwd: workingDirectory,
      env: { GH_DEBUG: "", GH_PROMPT_DISABLED: "1", GH_TOKEN: "", GITHUB_TOKEN: "" },
      timeoutMs: 10_000,
    })
    .pipe(
      Effect.map((output) => output.stdout.trim()),
      Effect.filterOrElse(
        (token) => token.length > 0,
        () => Effect.succeed("" as const),
      ),
      Effect.map((token): NodeJS.ProcessEnv => (token.length === 0 ? {} : { GH_TOKEN: token })),
      Effect.orElseSucceed((): NodeJS.ProcessEnv => ({})),
    );
});
