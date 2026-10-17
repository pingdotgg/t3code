import { builtInSourceControlDefinitions } from "@t3tools/source-control-definitions/registry";
import {
  HostCredentialSettings,
  readSourceControlHostSettings,
  type SourceControlAppSignIn,
  type SourceControlDefinition,
} from "@t3tools/source-control-core/shared/definition";
import type {
  RepositoryIdentity,
  ServerSettings,
  SourceControlAppAccessInput,
} from "@t3tools/contracts";
import { parseGitRemoteRepository } from "@t3tools/shared/git";

export {
  isMonochromeSourceControlIcon,
  UNKNOWN_SOURCE_CONTROL_CLIENT,
  type ChangeRequestLink,
  type ChangeRequestTerminology,
  type HostAccountChoice,
  type HostCredentialSettings,
  type ParsedChangeRequestUrl,
  type ReferenceAutolink,
  type SourceControlAppSignIn,
  type SourceControlDefinition,
  type SourceControlHostCredentials,
  type SourceControlIcon,
} from "@t3tools/source-control-core/shared/definition";

export const sourceControlClients = builtInSourceControlDefinitions;

/** The saved per-hostname accounts and tokens of a host whose definition has `credentials`. */
export function readHostCredentialSettings(
  settings: Pick<ServerSettings, "sourceControlHosts">,
  kind: string,
): HostCredentialSettings {
  return readSourceControlHostSettings(HostCredentialSettings, settings.sourceControlHosts[kind]);
}

/**
 * The repositories a project's pull requests come from, as `repositorySelector` names them: its
 * own, or for a folder that is no repository, the checkouts it holds. Two checkouts of one
 * repository name it once.
 */
export function projectRepositorySelectors(project: {
  readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
  readonly workspaceRepositories?: ReadonlyArray<RepositoryIdentity> | undefined;
}): ReadonlyArray<string> {
  const identities =
    project.repositoryIdentity != null
      ? [project.repositoryIdentity]
      : (project.workspaceRepositories ?? []);
  const selectors = new Map<string, string>();
  for (const identity of identities) {
    const selector = sourceControlClients.repositorySelector(identity);
    if (selector !== null && !selectors.has(selector.toLowerCase())) {
      selectors.set(selector.toLowerCase(), selector);
    }
  }
  return [...selectors.values()];
}

/** A host's change request term where it opens a sentence: "Merge request merged". */
export function capitalizeTerm(term: string): string {
  return term.charAt(0).toUpperCase() + term.slice(1);
}

/** The repository a remote names, when its host has an app sign-in that could reach it. */
export function appSignInTargetForRemote(remoteUrl: string): {
  readonly definition: SourceControlDefinition;
  readonly appSignIn: SourceControlAppSignIn;
  readonly input: SourceControlAppAccessInput;
} | null {
  const parsed = parseGitRemoteRepository(remoteUrl);
  const provider = sourceControlClients.recognizeRemote(remoteUrl);
  const definition = provider ? sourceControlClients.find(provider.kind) : undefined;
  const appSignIn = definition?.credentials?.appSignIn;
  if (parsed === null || definition === undefined || appSignIn === undefined) return null;
  if (!appSignIn.hosts.includes(parsed.host)) return null;
  // The parser lowercases; keep the remote's own casing for display when it names the same path.
  const asWritten = remoteUrl
    .trim()
    .replace(/\.git\/?$/i, "")
    .split(/[/:]/)
    .slice(-2)
    .join("/");
  const repository = asWritten.toLowerCase() === parsed.path ? asWritten : parsed.path;
  return {
    definition,
    appSignIn,
    input: { provider: definition.kind, host: parsed.host, repository },
  };
}
