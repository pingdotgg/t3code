import {
  type PullRequestAction,
  pullRequestHostOf,
  type PullRequestReviewVerdict,
  type RepositoryIdentity,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import type { ChangeRequestLink } from "@t3tools/shared/changeRequestUrl";
import * as Schema from "effect/Schema";

export interface ChangeRequestTerminology {
  readonly shortLabel: string;
  readonly singular: string;
}

export interface ChangeRequestUrlInput {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly remoteUrl?: string | undefined;
  readonly webUrl?: string | undefined;
}

export type ChangeRequestProjectIdentity = Pick<
  RepositoryIdentity,
  "canonicalKey" | "locator" | "webUrl" | "displayName" | "owner" | "name"
>;

export interface ChangeRequestCheckoutInput {
  readonly number: number;
  readonly headBranch: string;
  readonly headRepositoryNameWithOwner?: string | null | undefined;
  readonly repositoryUrl?: string | null | undefined;
}

export interface SourceControlClientDefinition {
  readonly kind: SourceControlProviderKind;
  readonly label: string;
  readonly pickerLabel: string;
  readonly icon: string;
  readonly changeRequest: ChangeRequestTerminology;
  readonly repositoryPathHint: string;
  readonly publicHost: string | null;
  readonly publishDescription: string;
  readonly publishHost: (signedInHost: string | null) => string;
  readonly newRepositoryOwner: (account: string | null) => { readonly owner: string | null } | null;
  readonly defaultCloneTransport: "https" | "ssh";
  readonly changeRequestUrl: (input: ChangeRequestUrlInput) => string | null;
  /** Must match the server provider's `capabilities.actions`. */
  readonly changeRequestActions: ReadonlySet<PullRequestAction>;
  readonly checkoutCommand: (changeRequest: ChangeRequestCheckoutInput) => string | null;
  readonly authorProfileUrl: (login: string, repositoryUrl: string) => string | null;
  readonly referenceAutolinkRepositoryUrl: (repositoryUrl: string) => string | null;
  readonly reviewSummaryRequired: (verdict: PullRequestReviewVerdict) => boolean;
  readonly checkoutCommandArgument: (input: string) => string | null;
  readonly isChangeRequestReference: (url: string) => boolean;
  readonly isChangeRequestInRepository: (
    identity: ChangeRequestProjectIdentity,
    link: ChangeRequestLink,
  ) => boolean;
  readonly canReadChangeRequestOnHost: (
    identity: ChangeRequestProjectIdentity,
    link: ChangeRequestLink,
  ) => boolean;
  readonly changeRequestUrlHost: (url: URL) => string;
  readonly checkoutChangeRequestHost: (identity: ChangeRequestProjectIdentity) => string | null;
  readonly isChangeRequestUrl: (url: string) => boolean;
  readonly settings?: SourceControlHostSettingsSchema;
}

export type SourceControlHostSettingsSchema = {
  readonly fields: Readonly<Record<string, Schema.Top>>;
} & Schema.Decoder<object>;

export function isChangeRequestPath(url: string, route: string): boolean {
  try {
    const path = new URL(url).pathname;
    const at = path.indexOf(route);
    return at > 0 && /^\d+(?:\/|$)/u.test(path.slice(at + route.length));
  } catch {
    return false;
  }
}

export function defineSourceControlClient<const Definition extends SourceControlClientDefinition>(
  definition: Definition,
): Definition {
  return definition;
}

export function isChangeRequestAuthorityOfProject(
  identity: ChangeRequestProjectIdentity,
  link: ChangeRequestLink,
): boolean {
  if (link.authority === undefined) return true;
  try {
    const remote = new URL(identity.locator.remoteUrl);
    if (remote.protocol === "http:" || remote.protocol === "https:") {
      return remote.host.toLowerCase() === link.authority;
    }
  } catch {
    // SSH remotes do not specify the server's HTTP port.
  }
  return true;
}

export function isChangeRequestOnProjectHost(
  kind: SourceControlProviderKind,
  identity: ChangeRequestProjectIdentity,
  link: ChangeRequestLink,
): boolean {
  if (!isChangeRequestAuthorityOfProject(identity, link)) return false;
  const host = pullRequestHostOf(identity, kind);
  return host === link.host.toLowerCase() || host === link.authority;
}

function projectRepositoryPath(identity: ChangeRequestProjectIdentity): string | null {
  return (
    identity.displayName ??
    (identity.owner && identity.name ? `${identity.owner}/${identity.name}` : null)
  );
}

export function isChangeRequestInProjectRepository(
  kind: SourceControlProviderKind,
  identity: ChangeRequestProjectIdentity,
  link: ChangeRequestLink,
): boolean {
  const repository = projectRepositoryPath(identity);
  return (
    repository !== null &&
    repository.toLowerCase() === link.repository.toLowerCase() &&
    isChangeRequestOnProjectHost(kind, identity, link)
  );
}

export const UNKNOWN_SOURCE_CONTROL_CLIENT: SourceControlClientDefinition = {
  kind: SourceControlProviderKind.make("unknown"),
  label: "source control",
  pickerLabel: "source control",
  icon: "change-request",
  changeRequest: { shortLabel: "change request", singular: "change request" },
  repositoryPathHint: "URL",
  publicHost: null,
  publishDescription: "Your signed-in server",
  publishHost: (signedInHost) => signedInHost ?? "your server",
  newRepositoryOwner: () => null,
  defaultCloneTransport: "ssh",
  changeRequestUrl: () => null,
  changeRequestActions: new Set(),
  checkoutCommand: () => null,
  authorProfileUrl: () => null,
  referenceAutolinkRepositoryUrl: () => null,
  reviewSummaryRequired: () => false,
  checkoutCommandArgument: () => null,
  isChangeRequestReference: () => false,
  changeRequestUrlHost: (url) => url.hostname,
  checkoutChangeRequestHost: () => null,
  isChangeRequestInRepository: (identity, link) =>
    isChangeRequestInProjectRepository(SourceControlProviderKind.make("unknown"), identity, link),
  canReadChangeRequestOnHost: (identity, link) =>
    isChangeRequestOnProjectHost(SourceControlProviderKind.make("unknown"), identity, link),
  isChangeRequestUrl: () => false,
};

export interface SourceControlClientRegistry {
  readonly definitions: ReadonlyArray<SourceControlClientDefinition>;
  readonly get: (kind: string | null | undefined) => SourceControlClientDefinition;
  readonly find: (kind: string) => SourceControlClientDefinition | undefined;
  readonly findByPublicHost: (hostname: string) => SourceControlClientDefinition | undefined;
  readonly findByChangeRequestUrl: (url: string) => SourceControlClientDefinition | undefined;
  readonly hostLabelForChangeRequestUrl: (url: string) => string;
}

export function makeSourceControlClientRegistry(
  definitions: ReadonlyArray<SourceControlClientDefinition>,
): SourceControlClientRegistry {
  const byKind = new Map<string, SourceControlClientDefinition>();
  for (const definition of definitions) {
    if (byKind.has(definition.kind)) {
      throw new Error(`Source control host '${definition.kind}' is defined more than once.`);
    }
    byKind.set(definition.kind, definition);
  }
  return {
    definitions,
    get: (kind) =>
      (kind == null ? definitions[0] : byKind.get(kind)) ?? UNKNOWN_SOURCE_CONTROL_CLIENT,
    find: (kind) => byKind.get(kind),
    findByPublicHost: (hostname) => {
      const host = hostname.toLowerCase();
      return definitions.find((definition) => definition.publicHost === host);
    },
    findByChangeRequestUrl: (url) =>
      definitions.find((definition) => definition.isChangeRequestUrl(url)),
    hostLabelForChangeRequestUrl: (url) =>
      definitions.find((definition) => definition.isChangeRequestUrl(url))?.label ?? "the host",
  };
}

export function readSourceControlHostSettings<S extends SourceControlHostSettingsSchema>(
  schema: S,
  saved: unknown,
): S["Type"] {
  const decode = Schema.decodeUnknownOption(schema as Schema.Decoder<S["Type"]>);
  const decoded = decode(saved ?? {});
  if (decoded._tag === "Some") return decoded.value;
  const fallback = decode({});
  if (fallback._tag === "Some") return fallback.value;
  throw new Error("A source control host settings schema must decode an empty object.");
}
