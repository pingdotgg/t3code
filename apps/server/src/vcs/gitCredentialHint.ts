/**
 * T3 Code runs git with terminal prompts disabled, so an HTTPS remote works
 * only when a credential helper on the server answers for its host. Without
 * one, git stops with `could not read Username for 'https://<host>'`. That
 * quote can carry a username, so only a host-shaped part after the last `@`
 * enters the message; anything else gets no hint.
 *
 * @module gitCredentialHint
 */

const MISSING_HTTPS_CREDENTIAL_PATTERN =
  /^fatal: could not read (?:Username|Password) for 'https?:\/\/([^']+)'/im;
// A DNS name or bracketed IPv6 literal, then an optional port and path.
const HOST_PATTERN = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d+)?(?:\/|$)/;

/**
 * Explains a failed clone or fetch whose HTTPS remote had no credential, or
 * undefined when the stderr shows some other failure.
 */
export function missingHttpsCredentialDetail(stderr: string): string | undefined {
  const remote = MISSING_HTTPS_CREDENTIAL_PATTERN.exec(stderr)?.[1];
  if (remote === undefined) return undefined;
  const host = HOST_PATTERN.exec(remote.slice(remote.lastIndexOf("@") + 1).toLowerCase())?.[1];
  if (host === undefined) return undefined;
  const setup =
    host === "github.com"
      ? "Run `gh auth login`, then `gh auth setup-git`, on that machine"
      : `Set up a Git credential helper for ${host} on that machine`;
  return `Git on the machine running this T3 Code server has no HTTPS credentials for ${host}. ${setup}, or use the repository's SSH URL.`;
}
