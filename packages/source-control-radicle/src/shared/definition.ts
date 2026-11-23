import { SourceControlProviderKind } from "@t3tools/contracts";
import {
  type ChangeRequestLink,
  type ChangeRequestProjectIdentity,
  type CommitLink,
  defineSourceControl,
  type RepositorySelectorIdentity,
} from "@t3tools/source-control-core/shared/definition";

export const KIND = SourceControlProviderKind.make("radicle");

/** Change requests are keyed under this host, since a Radicle repository lives on no server. */
const RADICLE_HOST = "radicle";

/** The public explorer. Private repositories do not load there, but the links still parse. */
export const RADICLE_EXPLORER = "https://radicle.network/nodes/seed.radicle.dev";

// A repository ID is `rad:` and a base58btc multibase string, which starts with `z`.
const RID_BODY = "z[1-9A-HJ-NP-Za-km-z]{20,64}";
const RID = new RegExp(`^(?:rad:)?(${RID_BODY})$`, "u");
const REMOTE = new RegExp(`^rad:(?://)?(${RID_BODY})(?:/(z[1-9A-HJ-NP-Za-km-z]+))?/?$`, "u");
const EXPLORER_PATCH_PATH = new RegExp(
  `^((?:/[^/]+)*/nodes/[^/]+/rad:(${RID_BODY}))/patches/([0-9a-f]{10,40})/?$`,
  "u",
);
const CHECKOUT_COMMAND = /^rad\s+patch\s+(?:checkout|co)\s+(\S+)/u;

/**
 * Patch IDs are 40-hex object IDs, but T3 keys change requests by a positive integer. The first
 * 10 hex digits (40 bits) stay exact as a JS number, and `rad` resolves them as an ID prefix.
 */
const PATCH_PREFIX_LENGTH = 10;

export function patchNumberFromId(id: string): number {
  return Number.parseInt(id.slice(0, PATCH_PREFIX_LENGTH), 16);
}

export function patchPrefixFromNumber(number: number): string {
  return number.toString(16).padStart(PATCH_PREFIX_LENGTH, "0");
}

/** The repository ID, with its case, from `rad:z…`, `z…`, or a selector built from either. */
export function parseRid(value: string): string | null {
  return RID.exec(value.trim())?.[1] ?? null;
}

/** A `rad://RID`, `rad://RID/NID` or `rad:RID` git remote. */
export function parseRadicleRemote(
  remoteUrl: string,
): { readonly rid: string; readonly nid: string | null } | null {
  const match = REMOTE.exec(remoteUrl.trim());
  return match?.[1] ? { rid: match[1], nid: match[2] ?? null } : null;
}

export function patchUrl(input: {
  readonly rid: string;
  readonly patch: string;
  readonly webUrl?: string | undefined;
}): string {
  return `${input.webUrl ?? `${RADICLE_EXPLORER}/rad:${input.rid}`}/patches/${input.patch}`;
}

const ridOfIdentity = (identity: ChangeRequestProjectIdentity) =>
  identity.name ? parseRid(identity.name) : null;

const isInRepository = (
  identity: ChangeRequestProjectIdentity,
  link: ChangeRequestLink | CommitLink,
) => {
  const rid = ridOfIdentity(identity);
  return (
    rid !== null &&
    link.host === RADICLE_HOST &&
    link.repository.toLowerCase() === rid.toLowerCase()
  );
};

export const definition = defineSourceControl({
  kind: KIND,
  label: "Radicle",
  pickerLabel: "Radicle",
  icon: null,
  searchKeywords: ["rad", "heartwood", "patch"],
  changeRequest: {
    shortLabel: "patch",
    shortLabelWithArticle: "a patch",
    singular: "patch",
    plural: "patches",
  },
  repositoryPathHint: "rad:z…",
  publicHost: null,
  publishDescription: "Your Radicle node",
  publishHost: () => "your Radicle node",
  newRepositoryOwner: () => ({ owner: null }),
  defaultCloneTransport: "https",
  changeRequestUrl: ({ repository, number, webUrl }) => {
    const rid = parseRid(repository);
    return rid === null ? null : patchUrl({ rid, patch: patchPrefixFromNumber(number), webUrl });
  },
  parseChangeRequestUrl: (url) => {
    const match = EXPLORER_PATCH_PATH.exec(url.pathname);
    if (!match?.[1] || !match[2] || !match[3]) return null;
    return {
      host: RADICLE_HOST,
      repository: match[2].toLowerCase(),
      number: patchNumberFromId(match[3]),
      repositoryUrl: `${url.origin}${match[1]}`,
    };
  },
  changeRequestUrlFromReferenceAutolink: () => null,
  changeRequestActions: new Set(["merge", "ready", "draft", "close", "reopen"] as const),
  checkoutCommand: ({ number }) => `rad patch checkout ${patchPrefixFromNumber(number)}`,
  changeRequestCloseCommand: /\brad\s+patch\s+archive\b/u,
  authorProfileUrl: () => null,
  // `rad patch comment` needs a message; an accept or reject verdict stands on its own.
  reviewSummaryRequired: (verdict) => verdict === "comment",
  checkoutCommandArgument: (input) => CHECKOUT_COMMAND.exec(input.trim())?.[1] ?? null,
  isChangeRequestReference: (url) => {
    try {
      return EXPLORER_PATCH_PATH.test(new URL(url).pathname);
    } catch {
      return false;
    }
  },
  isChangeRequestInRepository: isInRepository,
  canReadChangeRequestOnHost: (_identity, link) => link.host === RADICLE_HOST,
  checkoutChangeRequestHost: () => null,
  recognizeRemote: ({ remoteUrl }) => {
    const remote = parseRadicleRemote(remoteUrl);
    return remote === null
      ? null
      : { kind: KIND, name: "Radicle", baseUrl: `${RADICLE_EXPLORER}/rad:${remote.rid}` };
  },
  changeRequestHost: () => RADICLE_HOST,
  // `rad` takes the repository ID; the identity keeps its case in `name`.
  repositorySelector: (identity: RepositorySelectorIdentity) => {
    const rid = identity.name ? parseRid(identity.name) : null;
    return rid === null ? null : `rad:${rid}`;
  },
});
