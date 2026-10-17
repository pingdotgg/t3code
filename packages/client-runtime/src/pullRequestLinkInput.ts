import type { RepositoryIdentity } from "@t3tools/contracts";
import { canonicalizeGitCafePullRequestUrl } from "@t3tools/source-control-definitions/registry";

import { sourceControlClients } from "./sourceControlClients.ts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

const PULL_REQUEST_NUMBER_PATTERN = /^#?(\d+)$/;

export function parsePullRequestReference(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const normalizedInput =
    sourceControlClients.definitions
      .map((definition) => definition.checkoutCommandArgument(trimmed))
      .find((argument) => argument !== null) ?? trimmed;
  if (normalizedInput.length === 0) {
    return null;
  }

  if (
    sourceControlClients.definitions.some((definition) =>
      definition.isChangeRequestReference(normalizedInput),
    )
  ) {
    return normalizedInput;
  }

  const numberMatch = PULL_REQUEST_NUMBER_PATTERN.exec(normalizedInput);
  if (numberMatch?.[1]) {
    return numberMatch[1];
  }

  return null;
}

/** One repository a bare number can resolve to one of its pull requests in. */
function pullRequestLinkProject(identity: RepositoryIdentity | null | undefined) {
  if (!identity) return null;
  const repository =
    identity.displayName ??
    (identity.owner && identity.name ? `${identity.owner}/${identity.name}` : null);
  if (repository === null) return null;
  const definition = sourceControlClients.get(identity.provider ?? "unknown");
  const host = sourceControlClients.changeRequestHost(identity, definition.kind);
  return {
    host,
    repository,
    terminology: definition.changeRequest,
    webUrl: (number: number) =>
      definition.changeRequestUrl({
        host,
        repository,
        number,
        remoteUrl: identity.locator.remoteUrl,
        webUrl: identity.webUrl,
      }),
  };
}

type LinkRepository = NonNullable<ReturnType<typeof pullRequestLinkProject>>;

/**
 * The thread project's repositories: its own, or the checkouts in a workspace folder, where two
 * checkouts of one repository are one repository to link from.
 */
export function pullRequestLinkRepositories(
  project:
    | {
        readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
        readonly workspaceRepositories?: ReadonlyArray<RepositoryIdentity> | undefined;
      }
    | null
    | undefined,
): ReadonlyArray<LinkRepository> {
  if (!project) return [];
  const identities =
    project.repositoryIdentity != null
      ? [project.repositoryIdentity]
      : (project.workspaceRepositories ?? []);
  const seen = new Set<string>();
  return identities.flatMap((identity) => {
    const repository = pullRequestLinkProject(identity);
    if (repository === null) return [];
    const key = `${repository.host}/${repository.repository}`.toLowerCase();
    if (seen.has(key)) return [];
    seen.add(key);
    return [repository];
  });
}

interface ResolvedLink {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly url: string;
}

function linkInRepository(
  repository: LinkRepository,
  number: number,
  resolve: MFunctionType,
): { link: ResolvedLink } | { error: string } {
  const webUrl = repository.webUrl(number);
  const webReference =
    webUrl === null ? undefined : sourceControlClients.parseChangeRequestUrl(webUrl)?.link;
  if (webUrl === null || webReference === undefined) {
    return {
      error: resolve(
        msg("Paste a full URL; this project's host has no known {changeRequest} URL.", {
          changeRequest: repository.terminology.singular,
        }),
      ),
    };
  }
  return {
    link: {
      host: webReference.host,
      repository: webReference.repository,
      number: webReference.number,
      url: webUrl,
    },
  };
}

/**
 * A bare number names a pull request in the thread's only repository; among a workspace folder's
 * checkouts, `repo#123` or `owner/repo#123` picks one.
 */
export function resolveLinkPullRequestInput(
  input: {
    readonly reference: string;
    readonly repositories: ReadonlyArray<LinkRepository>;
    readonly hasProject: (reference: ResolvedLink) => boolean;
  },
  resolve: MFunctionType = mFallback,
): { link: ResolvedLink } | { error: string } | null {
  const trimmed = input.reference.trim();
  const isUrl = sourceControlClients.parseChangeRequestUrl(trimmed) !== null;
  const named = isUrl ? null : /^([\w.-]+(?:\/[\w.-]+)*)#(\d+)$/u.exec(trimmed);
  if (named?.[1] && named[2]) {
    const name = named[1].toLowerCase();
    const matches = input.repositories.filter((candidate) => {
      const repository = candidate.repository.toLowerCase();
      return repository === name || repository.split("/").at(-1) === name;
    });
    const number = Number(named[2]);
    if (!Number.isSafeInteger(number) || number < 1) return null;
    if (matches.length === 1) return linkInRepository(matches[0]!, number, resolve);
    return {
      error:
        matches.length === 0
          ? // oxlint-disable-next-line t3code/no-untranslated-copy -- the fork's workspace folder copy is English
            `This project holds no repository named ${named[1]}.`
          : // oxlint-disable-next-line t3code/no-untranslated-copy -- the fork's workspace folder copy is English
            `${named[1]} names more than one repository here; write owner/repo#${number}.`,
    };
  }
  const parsed = isUrl ? trimmed : parsePullRequestReference(input.reference);
  if (parsed === null) return null;
  const url = sourceControlClients.parseChangeRequestUrl(parsed)?.link;
  if (url !== undefined) {
    if (!input.hasProject({ ...url, url: parsed })) {
      return {
        error: resolve(
          msg("No project in this environment can read {host}/{repository}.", {
            host: url.host,
            repository: url.repository,
          }),
        ),
      };
    }
    return {
      link: {
        host: url.host,
        repository: url.repository,
        number: url.number,
        url: canonicalizeGitCafePullRequestUrl(parsed),
      },
    };
  }
  const number = Number(parsed);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  const [only, ...others] = input.repositories;
  if (only === undefined) {
    return {
      error: resolve(
        msg(
          "Paste the full pull request URL; this thread has no repository to resolve the number against.",
        ),
      ),
    };
  }
  if (others.length > 0) {
    return {
      // oxlint-disable-next-line t3code/no-untranslated-copy -- the fork's workspace folder copy is English
      error: "This folder holds several repositories; enter repo#123, or paste the URL.",
    };
  }
  return linkInRepository(only, number, resolve);
}
