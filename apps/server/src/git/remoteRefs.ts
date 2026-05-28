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
