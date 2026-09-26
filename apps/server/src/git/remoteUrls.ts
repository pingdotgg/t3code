/** Parses `git remote -v`, including the filter Git appends for partial clones. */
export function parseGitRemoteVerboseOutput(output: string) {
  const remotes = new Map<string, { url?: string; pushUrl?: string }>();
  for (const line of output.split("\n")) {
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)(?:\s+\[[^\]\r\n]+\])?$/.exec(line.trim());
    if (!match) continue;
    const [, name, url, direction] = match;
    if (!name || !url) continue;
    const remote = remotes.get(name) ?? {};
    if (direction === "fetch") {
      remote.url = url;
    } else {
      remote.pushUrl = url;
    }
    remotes.set(name, remote);
  }
  return remotes;
}

export function parseRemoteFetchUrls(output: string): Map<string, string> {
  return new Map(
    Array.from(parseGitRemoteVerboseOutput(output)).flatMap(([name, remote]) =>
      remote.url ? [[name, remote.url]] : [],
    ),
  );
}
