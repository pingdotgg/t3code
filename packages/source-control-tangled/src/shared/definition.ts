import {
  makeProviderSettingsSchema,
  SourceControlProviderKind,
  TrimmedString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  defineSourceControl,
  isChangeRequestInProjectRepository,
  isChangeRequestOnProjectHost,
  parseChangeRequestPath,
  projectChangeRequestHost,
} from "@t3tools/source-control-core/shared/definition";

const KIND = SourceControlProviderKind.make("tangled");

/**
 * The appview and knot `tg` reads when it has nothing else configured. Both are overridable in
 * Source Control settings, which is how a self-hosted appview or a different knot is reached.
 */
const DEFAULT_APPVIEW = "https://api.tangled.org";
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

export const definition = defineSourceControl({
  kind: KIND,
  label: "Tangled",
  pickerLabel: "Tangled",
  icon: {
    viewBox: "0 0 32 32",
    paths: [
      {
        fill: "currentColor",
        d: "M21.0971 30.866C20.0566 30.8575 19.2628 30.5542 18.4016 30.0269C17.1668 29.3753 16.2237 28.2808 15.5497 27.0739C14.4789 28.4065 13.0476 29.215 11.4453 29.6718C10.763 29.8705 9.56809 30.0721 7.58737 29.3523C4.73277 28.3905 2.65342 25.4114 2.88973 22.3758C2.8465 21.1175 3.30392 19.8825 3.95228 18.8208C2.22264 17.8897 0.81225 16.3266 0.272148 14.4098C-0.0560731 13.3604 -0.042271 12.2299 0.0787626 11.1512C0.512215 8.60429 2.41697 6.38956 4.86912 5.59294C5.8479 3.35574 7.98378 1.68743 10.4037 1.34778C12.0104 1.12338 13.6735 1.46075 15.0792 2.27979C17.1272 0.00158595 20.6952 -0.671697 23.4195 0.727793C25.4978 1.72322 26.9839 3.80003 27.3447 6.06471C29.3222 6.85928 30.9877 8.47971 31.6413 10.5368C32.0784 11.8104 32.0928 13.2132 31.8098 14.5209C31.3041 16.5615 29.8679 18.2987 28.009 19.2482C28.0135 19.6113 29.2037 22.2296 29.0047 24.2056C28.9612 26.676 27.399 29.0172 25.2325 30.1544C23.9683 30.8945 22.4702 30.8805 21.0971 30.866ZM15.1733 23.755C16.9256 23.5593 18.0743 22.0269 18.9665 20.6469C19.3883 20.0182 19.7105 19.3146 20.0306 18.6454C20.4458 19.0271 20.7975 19.7461 21.4541 19.9173C22.1457 20.1333 22.9566 19.9579 23.38 19.3277C24.1902 17.8118 23.7908 15.9827 23.319 14.4119C23.0284 13.5097 22.6472 12.5841 21.9218 11.9446C22.0765 10.85 21.4299 9.73834 20.5106 9.16542C19.7272 9.79198 18.5352 9.78821 17.7794 9.11795C16.3309 10.5997 15.0034 10.5505 13.7212 9.37618C13.4331 9.11226 12.8832 10.9871 10.9535 9.92506C9.84488 10.8567 8.98526 11.753 8.22356 13.0435C7.48342 14.4347 6.70829 15.6703 6.64151 17.1811C6.6094 18.0641 7.29731 18.9892 8.22942 18.9174C9.16105 19.0009 9.7952 18.0813 10.5006 17.6993C10.6058 18.9316 10.7243 20.2556 11.1395 21.4587C11.6161 23.0155 13.2947 24.005 14.8835 23.7784C14.9959 23.7696 15.1733 23.7549 15.1733 23.755ZM16.0828 19.1062C15.2306 18.5823 15.6407 17.4452 15.6066 16.6193C15.6914 15.6227 15.7594 14.575 16.2061 13.667C16.6788 13.0197 17.8318 13.2694 17.8827 14.0999C17.8488 14.9353 17.4664 15.767 17.5121 16.633C17.4129 17.3561 17.5839 18.1684 17.265 18.8293C17.0033 19.195 16.4703 19.3013 16.0828 19.1062ZM12.3606 18.6302C11.5578 18.1933 11.8129 17.0941 11.687 16.3298C11.7914 15.445 11.7045 14.3226 12.4431 13.7021C13.1653 13.1969 14.1485 14.0621 13.8069 14.8564C13.4426 15.8602 13.6814 16.957 13.6891 17.9748C13.5512 18.5752 12.911 18.894 12.3606 18.6302Z",
      },
    ],
  },
  changeRequest: {
    shortLabel: "PR",
    shortLabelWithArticle: "a PR",
    singular: "pull request",
    plural: "pull requests",
  },
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
  changeRequestUrlFromReferenceAutolink: () => null,
  reviewSummaryRequired: () => false,
  checkoutCommandArgument: () => null,
  isChangeRequestReference: () => false,
  checkoutChangeRequestHost: () => null,
  isChangeRequestInRepository: (identity, link) =>
    isChangeRequestInProjectRepository(projectChangeRequestHost(identity, KIND), identity, link),
  canReadChangeRequestOnHost: (identity, link) =>
    isChangeRequestOnProjectHost(projectChangeRequestHost(identity, KIND), identity, link),
  recognizeRemote: ({ hostname }) =>
    isTangledHost(hostname)
      ? { kind: KIND, name: "Tangled", baseUrl: `https://${hostname}` }
      : null,
  parseChangeRequestUrl: (url) =>
    isTangledHost(url.hostname)
      ? parseChangeRequestPath(url, /^\/([^/]+\/[^/]+)\/pulls\/(\d+)(?:\/|$)/u)
      : null,
  settings,
});

/** The SSH remote `tg` writes, which the tangled.org proxy resolves to the owning knot. */
export function repositorySshUrl(repository: string): string {
  return `git@tangled.org:${repository}`;
}

/** The HTTPS remote, which redirects to the knot actually holding the repository. */
export function repositoryCloneUrl(repository: string): string {
  return `https://tangled.org/${repository}`;
}
