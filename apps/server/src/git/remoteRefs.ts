export function parseRemoteNamesInGitOrder(stdout: string): ReadonlyArray<string> {
  const remoteNames: Array<string> = [];
  for (const line of stdout.split("\n")) {
    const remoteName = line.trim();
    if (remoteName.length > 0) {
      remoteNames.push(remoteName);
    }
  }
  return remoteNames;
}

export function parseRemoteNames(stdout: string): ReadonlyArray<string> {
  return parseRemoteNamesInGitOrder(stdout).toSorted((a, b) => b.length - a.length);
}

/**
 * Reads `git remote -v` output, one entry per remote and direction. Promisor (partial-clone)
 * remotes print their filter after the direction, as in `origin <url> (fetch) [blob:none]`, so
 * trailing bracketed annotations are accepted and dropped.
 */
export function parseGitRemoteVerbose(stdout: string) {
  const remotes: Array<{ name: string; url: string; direction: "fetch" | "push" }> = [];
  for (const line of stdout.split("\n")) {
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)(?:\s+\[[^\]]*\])*$/.exec(line.trim());
    if (!match) continue;
    const [, name = "", url = "", direction] = match;
    remotes.push({ name, url, direction: direction === "fetch" ? "fetch" : "push" });
  }
  return remotes;
}

/** Fetch URL per remote name from `git remote -v` output; a later line for the same name wins. */
export function parseRemoteFetchUrls(stdout: string): Map<string, string> {
  return new Map(
    parseGitRemoteVerbose(stdout)
      .filter((entry) => entry.direction === "fetch")
      .map((entry) => [entry.name, entry.url]),
  );
}

export function parseRemoteRefWithRemoteNames(
  ref: string,
  remoteNames: ReadonlyArray<string>,
): { remoteRef: string; remoteName: string; branchName: string } | null {
  const trimmedRef = ref.trim();
  if (trimmedRef.length === 0) {
    return null;
  }

  for (const remoteName of remoteNames) {
    const remotePrefix = `${remoteName}/`;
    if (!trimmedRef.startsWith(remotePrefix)) {
      continue;
    }
    const branchName = trimmedRef.slice(remotePrefix.length).trim();
    if (branchName.length === 0) {
      return null;
    }
    return {
      remoteRef: trimmedRef,
      remoteName,
      branchName,
    };
  }

  return null;
}

export function extractBranchNameFromRemoteRef(
  ref: string,
  options?: {
    remoteName?: string | null;
    remoteNames?: ReadonlyArray<string>;
  },
): string {
  const normalized = ref.trim();
  if (normalized.length === 0) {
    return "";
  }

  if (normalized.startsWith("refs/remotes/")) {
    return extractBranchNameFromRemoteRef(normalized.slice("refs/remotes/".length), options);
  }

  const remoteNames = options?.remoteName ? [options.remoteName] : (options?.remoteNames ?? []);
  const parsedRemoteRef = parseRemoteRefWithRemoteNames(normalized, remoteNames);
  if (parsedRemoteRef) {
    return parsedRemoteRef.branchName;
  }

  const firstSlash = normalized.indexOf("/");
  if (firstSlash === -1) {
    return normalized;
  }
  return normalized.slice(firstSlash + 1).trim();
}
