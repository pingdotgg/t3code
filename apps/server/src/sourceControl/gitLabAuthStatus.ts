const HOST_LINE_PATTERN = /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[a-f0-9:.]+\])(?::\d+)?$/iu;
const LOGGED_IN_PATTERN = /Logged in to .+? as\s+([^\s(]+)/iu;

export interface GitLabAuthStatusHost {
  readonly host: string;
  readonly account: string | null;
}

export function parseGitLabAuthStatusHosts(text: string): ReadonlyArray<GitLabAuthStatusHost> {
  const hosts: GitLabAuthStatusHost[] = [];
  let currentHost: string | null = null;
  let currentLines: string[] = [];

  const flush = () => {
    if (currentHost === null) return;

    const account = LOGGED_IN_PATTERN.exec(currentLines.join("\n"))?.[1]?.trim() || null;
    hosts.push({ host: currentHost, account });
    currentHost = null;
    currentLines = [];
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    const isHostLine =
      rawLine.length === rawLine.trimStart().length && HOST_LINE_PATTERN.test(line);
    if (isHostLine) {
      flush();
      currentHost = line.toLowerCase();
      continue;
    }

    if (currentHost !== null) {
      currentLines.push(line);
    }
  }

  flush();
  return hosts;
}

export function findAuthenticatedGitLabHost(
  hosts: ReadonlyArray<GitLabAuthStatusHost>,
): GitLabAuthStatusHost | undefined {
  return hosts.find((host) => host.account !== null);
}
