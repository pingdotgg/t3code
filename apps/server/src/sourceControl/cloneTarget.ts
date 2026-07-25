/**
 * Validation for the untrusted strings this server hands to `git` and to
 * provider CLIs as positional arguments.
 *
 * `git` (and `gh`/`glab`/`az`) parse any argument starting with `-` as an
 * option no matter where it appears, and several git options run commands:
 * `--upload-pack=`, `--config=core.sshCommand=`, and the `ext::` transport all
 * turn a clone URL into arbitrary code execution. Callers must additionally
 * pass `--` before positional arguments so a value that slips past these
 * checks still cannot be reinterpreted as an option.
 *
 * @module cloneTarget
 */

/**
 * URL schemes git may use for a clone.
 *
 * Deliberately excludes `ext::` and the other transport-helper forms, which
 * execute a command supplied in the URL.
 */
const ALLOWED_REMOTE_URL_SCHEMES: ReadonlySet<string> = new Set([
  "file",
  "git",
  "git+ssh",
  "http",
  "https",
  "ssh",
]);

const URL_SCHEME_PATTERN = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//;
/** `ext::`, `transport::`, and friends: a scheme followed by `::`. */
const TRANSPORT_HELPER_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*::/;

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * Reject a clone URL that git could interpret as an option or as a
 * command-executing transport.
 *
 * Returns a user-facing rejection reason, or `null` when the URL is safe to
 * pass as a positional argument.
 */
export function remoteUrlRejectionReason(remoteUrl: string): string | null {
  if (remoteUrl.length === 0) {
    return "Enter a repository path or clone URL before cloning.";
  }
  if (containsControlCharacter(remoteUrl)) {
    return "Clone URLs cannot contain control characters.";
  }
  if (remoteUrl.startsWith("-")) {
    return "Clone URLs cannot start with '-'.";
  }

  const scheme = URL_SCHEME_PATTERN.exec(remoteUrl)?.[1];
  if (scheme !== undefined) {
    return ALLOWED_REMOTE_URL_SCHEMES.has(scheme.toLowerCase())
      ? null
      : `Clone URL scheme '${scheme}' is not supported.`;
  }
  if (TRANSPORT_HELPER_PATTERN.test(remoteUrl)) {
    return "Clone URLs cannot use a git transport helper.";
  }

  // Everything left is either scp-style ssh (`git@host:owner/repo.git`) or a
  // local path, neither of which can carry a transport command.
  return null;
}

/**
 * Reject a provider repository identifier that a provider CLI could interpret
 * as an option.
 *
 * Returns a user-facing rejection reason, or `null` when the identifier is
 * safe to pass as a positional argument.
 */
export function repositoryIdentifierRejectionReason(repository: string): string | null {
  if (repository.length === 0) {
    return "Enter a repository before continuing.";
  }
  if (containsControlCharacter(repository)) {
    return "Repository names cannot contain control characters.";
  }
  if (repository.startsWith("-")) {
    return "Repository names cannot start with '-'.";
  }
  return null;
}
