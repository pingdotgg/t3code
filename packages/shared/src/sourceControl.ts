const SCP_SSH_REMOTE_PATTERN = /^[a-zA-Z0-9._-]+@([^:/]+):/;
// Git reads `host:path` as SSH too, leaving the user to ssh config. A single letter is a Windows
// drive and `::` names a remote helper.
const USERLESS_SCP_SSH_REMOTE_PATTERN = /^([^@:/\\\s]{2,}):(?!:)\/?[^/\s]+(?:\/[^/\s]+)+\/?$/u;

/** Null unless the remote is `host:path`, with no user. */
export function userlessScpRemoteHost(remoteUrl: string): string | null {
  return USERLESS_SCP_SSH_REMOTE_PATTERN.exec(remoteUrl.trim())?.[1] ?? null;
}

export function isSshRemoteUrl(remoteUrl: string): boolean {
  const trimmed = remoteUrl.trim();
  return (
    SCP_SSH_REMOTE_PATTERN.test(trimmed) ||
    trimmed.toLowerCase().startsWith("ssh://") ||
    userlessScpRemoteHost(trimmed) !== null
  );
}
