/**
 * The GitHub account a workspace's repository reads as. Settings choose one per repository or
 * owner, so the media in its pull requests and the agents working in it act as the same login
 * its pull request pages are read as.
 *
 * @module sourceControl/GitHubWorkspaceAccount
 */
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import * as GitHubCredentials from "@t3tools/source-control-github/server/GitHubCredentials";
import { gitHubApiHostForRemote } from "@t3tools/source-control-github/server/gitHubRepositoryResolution";

import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";

/**
 * The GitHub host and `owner/name` of the repository checked out at `cwd`, or null for anything
 * else.
 */
const workspaceGitHubRepository = Effect.fn("GitHubWorkspaceAccount.repository")(function* (
  cwd: string,
) {
  const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const identity = yield* resolver.resolve(cwd);
  if (identity === null) return null;
  const host = gitHubApiHostForRemote(identity.locator.remoteUrl);
  const owner = identity.owner?.trim();
  const name = identity.name?.trim();
  return host === null || !owner || !name ? null : { host, repository: `${owner}/${name}` };
});

/** The credential the workspace's repository is read with, or null where there is none. */
export const workspaceGitHubCredential = Effect.fn("GitHubWorkspaceAccount.credential")(function* (
  cwd: string,
) {
  const workspace = yield* workspaceGitHubRepository(cwd);
  if (workspace === null) return null;
  const credentials = yield* GitHubCredentials.GitHubCredentials;
  return yield* credentials
    .get(workspace.host, workspace.repository)
    .pipe(Effect.orElseSucceed(() => null));
});

/**
 * Variables for the agent processes working in `cwd`, so `gh` and git over HTTPS inside them act
 * as the account Settings choose for the repository. Empty unless Settings picked a login
 * of their own: an environment token reaches the agent already, and gh's active login is what an
 * agent without `GH_TOKEN` gets anyway.
 */
export const agentGitHubEnvironment = Effect.fn("GitHubWorkspaceAccount.agentEnvironment")(
  function* (cwd: string) {
    const none: Readonly<Record<string, Redacted.Redacted<string>>> = {};
    const workspace = yield* workspaceGitHubRepository(cwd);
    if (workspace === null) return none;
    const credentials = yield* GitHubCredentials.GitHubCredentials;
    // Settings first, so a turn in a workspace no rule covers never waits on `gh`.
    if ((yield* credentials.accountFor(workspace.host, workspace.repository)) === undefined) {
      return none;
    }
    const credential = yield* credentials
      .get(workspace.host, workspace.repository)
      .pipe(Effect.orElseSucceed(() => null));
    if (credential?.account === undefined) return none;
    // gh reads `GH_ENTERPRISE_TOKEN` for every host but github.com and GHE.com.
    const variable = GitHubCredentials.isGitHubDotCom(credential.host)
      ? "GH_TOKEN"
      : "GH_ENTERPRISE_TOKEN";
    return { [variable]: credential.token };
  },
);
