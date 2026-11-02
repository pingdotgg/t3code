import { builtInSourceControlDefinitions } from "@t3tools/source-control-definitions/registry";
import {
  type ChangeRequestTerminology,
  HostCredentialSettings,
  readSourceControlHostSettings,
  resolveChangeRequestTerms,
  type SourceControlAppSignIn,
  type SourceControlDefinition,
  UNKNOWN_SOURCE_CONTROL_CLIENT,
} from "@t3tools/source-control-core/shared/definition";
import type { ServerSettings, SourceControlAppAccessInput } from "@t3tools/contracts";
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

// Mirrors the client's `providerSpecificTerminology` setting, so plain functions can read it.
let providerChangeRequestTerms = true;

export function providerChangeRequestTermsEnabled(): boolean {
  return providerChangeRequestTerms;
}

export function setProviderChangeRequestTerms(enabled: boolean): void {
  providerChangeRequestTerms = enabled;
}

/** The change request terms to show for a host kind or definition, honoring the user's setting. */
export function changeRequestTermsFor(
  host: SourceControlDefinition | string | null | undefined,
): ChangeRequestTerminology {
  const definition =
    typeof host === "object" && host !== null ? host : sourceControlClients.get(host);
  return resolveChangeRequestTerms(definition, providerChangeRequestTerms);
}

/** One set of terms for a list spanning hosts: theirs when every host agrees, else "pull request". */
export function changeRequestTermsForHosts(
  hosts: Iterable<string | null | undefined>,
  useProviderTerms = providerChangeRequestTerms,
): ChangeRequestTerminology {
  const pullRequest = resolveChangeRequestTerms(UNKNOWN_SOURCE_CONTROL_CLIENT, false);
  let shared: ChangeRequestTerminology | undefined;
  for (const host of hosts) {
    if (!host) continue;
    const terms = resolveChangeRequestTerms(sourceControlClients.get(host), useProviderTerms);
    if (shared !== undefined && shared.plural !== terms.plural) return pullRequest;
    shared = terms;
  }
  return shared ?? pullRequest;
}

/** The saved per-hostname accounts and tokens of a host whose definition has `credentials`. */
export function readHostCredentialSettings(
  settings: Pick<ServerSettings, "sourceControlHosts">,
  kind: string,
): HostCredentialSettings {
  return readSourceControlHostSettings(HostCredentialSettings, settings.sourceControlHosts[kind]);
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
