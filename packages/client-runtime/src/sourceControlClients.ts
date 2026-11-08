import { builtInSourceControlDefinitions } from "@t3tools/source-control-definitions/registry";
import {
  type ChangeRequestTerminology,
  HostCredentialSettings,
  readSourceControlHostSettings,
  changeRequestTerms,
  type SourceControlAppSignIn,
  type SourceControlDefinition,
} from "@t3tools/source-control-core/shared/definition";
import type { ServerSettings, SourceControlAppAccessInput } from "@t3tools/contracts";
import { parseGitRemoteRepository } from "@t3tools/shared/git";

export {
  changeRequestTerms,
  isMonochromeSourceControlIcon,
  MERGE_REQUEST_TERMINOLOGY,
  PULL_REQUEST_TERMINOLOGY,
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

// Mirrors the client's `mergeRequestTerminology` setting, so plain functions can read it.
let mergeRequestTerms = false;

export function mergeRequestTermsEnabled(): boolean {
  return mergeRequestTerms;
}

export function setMergeRequestTerms(enabled: boolean): void {
  mergeRequestTerms = enabled;
}

/** "Pull request" or "merge request" for every host, as the user's setting picks. */
export function currentChangeRequestTerms(): ChangeRequestTerminology {
  return changeRequestTerms(mergeRequestTerms);
}

export function formatChangeRequestText(text: string, terms = currentChangeRequestTerms()): string {
  return text.replace(
    /https?:\/\/[^\s<>"`]+|\b(?:a PR|an MR)\b|\b(?:PR|MR)s?\b|\b(?:[Pp]ull|[Mm]erge) [Rr]equests?\b/gu,
    (match) => {
      if (match.startsWith("http")) return match;
      if (match === "a PR" || match === "an MR") return terms.shortLabelWithArticle;
      if (match === "PR" || match === "MR") return terms.shortLabel;
      if (match === "PRs" || match === "MRs") return `${terms.shortLabel}s`;
      const label = match.endsWith("s") ? terms.plural : terms.singular;
      if (match.startsWith("pull") || match.startsWith("merge")) return label;
      return match.includes("Request")
        ? label.split(" ").map(capitalizeTerm).join(" ")
        : capitalizeTerm(label);
    },
  );
}

/** The saved per-hostname accounts and tokens of a host whose definition has `credentials`. */
export function readHostCredentialSettings(
  settings: Pick<ServerSettings, "sourceControlHosts">,
  kind: string,
): HostCredentialSettings {
  return readSourceControlHostSettings(HostCredentialSettings, settings.sourceControlHosts[kind]);
}

/** A change request term where it opens a sentence: "Merge request merged". */
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
