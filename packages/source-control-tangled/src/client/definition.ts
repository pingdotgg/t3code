/**
 * Tangled's client definition. Browser- and React Native-safe.
 *
 * @module source-control-tangled/client/definition
 */
import {
  makeProviderSettingsSchema,
  SourceControlProviderKind,
  TrimmedString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  defineSourceControlClient,
  isChangeRequestInProjectRepository,
  isChangeRequestOnProjectHost,
  isChangeRequestPath,
} from "@t3tools/source-control-core/client/definition";

const KIND = SourceControlProviderKind.make("tangled");

/**
 * The appview and knot `tg` reads when it has nothing else configured. Both are overridable in
 * Source Control settings, which is how a self-hosted appview or a different knot is reached.
 */
export const DEFAULT_APPVIEW = "https://api.next.tangled.org";
export const DEFAULT_KNOT = "knot1.tangled.sh";

export const settings = makeProviderSettingsSchema({
  knot: TrimmedString.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_KNOT)),
    Schema.annotateKey({
      title: "Knot",
      description: `The knot that hosts new repositories. Leave as ${DEFAULT_KNOT}, or name your own knot.`,
      providerSettingsForm: { control: "text", placeholder: DEFAULT_KNOT },
    }),
  ),
  appview: TrimmedString.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_APPVIEW)),
    Schema.annotateKey({
      title: "Appview",
      description: `The appview that resolves handles, repositories and pull requests. Leave as ${DEFAULT_APPVIEW}, or name your own.`,
      providerSettingsForm: { control: "text", placeholder: DEFAULT_APPVIEW },
    }),
  ),
});
export type TangledSettings = typeof settings.Type;

/** Whether a hostname is one tangled.org serves its repository pages under. */
function isTangledHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "tangled.org" ||
    host === "tangled.sh" ||
    host.endsWith(".tangled.org") ||
    host.endsWith(".tangled.sh")
  );
}

export const definition = defineSourceControlClient({
  kind: KIND,
  label: "Tangled",
  pickerLabel: "Tangled",
  icon: "tangled",
  changeRequest: { shortLabel: "PR", singular: "pull request" },
  repositoryPathHint: "handle/repo",
  // `handle.knot.tangled.sh` remotes are addressed by the proxy, so a bare hostname does not
  // name this host the way tangled.org and its knots do.
  publicHost: null,
  publishDescription: "tangled.org",
  publishHost: () => "tangled.org",
  // `tg repo create` publishes under the signed-in account unless `--knot` names another owner.
  newRepositoryOwner: (account) => (account ? { owner: account } : null),
  defaultCloneTransport: "ssh",
  changeRequestUrl: ({ host, repository, number }) =>
    `https://${host}/${repository}/pulls/${number}`,
  // Pull requests can be read and created, but this adapter exposes no mutation actions.
  changeRequestActions: new Set(),
  // `tg pr checkout` takes an AT Protocol record key, not the number a pull request URL shows,
  // so no checkout command can be built from what a client knows.
  checkoutCommand: () => null,
  authorProfileUrl: (login) => `https://tangled.org/${login}`,
  referenceAutolinkRepositoryUrl: () => null,
  reviewSummaryRequired: () => false,
  checkoutCommandArgument: () => null,
  isChangeRequestReference: () => false,
  changeRequestUrlHost: (url) => url.hostname,
  checkoutChangeRequestHost: () => null,
  isChangeRequestInRepository: (identity, link) =>
    isChangeRequestInProjectRepository(KIND, identity, link),
  canReadChangeRequestOnHost: (identity, link) =>
    isChangeRequestOnProjectHost(KIND, identity, link),
  isChangeRequestUrl: (url) => {
    try {
      return isTangledHost(new URL(url).hostname) && isChangeRequestPath(url, "/pulls/");
    } catch {
      return false;
    }
  },
  settings,
});

/** The URL a repository's pages are served from, from its `handle/repo` path. */
export function repositoryWebUrl(repository: string): string {
  return `https://tangled.org/${repository}`;
}

/** The SSH remote `tg` writes, which the tangled.org proxy resolves to the owning knot. */
export function repositorySshUrl(repository: string): string {
  return `git@tangled.org:${repository}`;
}

/** The HTTPS remote, which redirects to the knot actually holding the repository. */
export function repositoryCloneUrl(repository: string): string {
  return `https://tangled.org/${repository}`;
}
