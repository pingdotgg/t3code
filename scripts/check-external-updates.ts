import { readFile } from "node:fs/promises";

type RepoRef = {
  owner: string;
  name: string;
};

type WatchConfig = {
  upstream: {
    repo: string;
    branch: string;
  };
  omarchy: {
    repo: string;
    trackedVersion: string;
  };
};

type GitHubRepo = {
  default_branch: string;
};

type GitHubCompare = {
  status: string;
  ahead_by: number;
  behind_by: number;
  html_url: string;
  base_commit: {
    sha: string;
  };
  merge_base_commit: {
    sha: string;
  };
};

type GitHubRelease = {
  tag_name: string;
  html_url: string;
  published_at: string | null;
};

type GitHubIssue = {
  number: number;
  title: string;
  body: string | null;
  pull_request?: unknown;
};

type IssueDraft = {
  marker: string;
  title: string;
  body: string;
};

const CONFIG_PATH = ".github/external-watch.json";

function hasFlag(flag: string): boolean {
  return process.argv.slice(2).includes(flag);
}

function getFlagValue(flag: string): string | null {
  const argv = process.argv.slice(2);
  const flagIndex = argv.indexOf(flag);
  if (flagIndex === -1) {
    return null;
  }
  return argv[flagIndex + 1] ?? null;
}

function parseRepoRef(value: string): RepoRef {
  const [owner, name, ...rest] = value.split("/");
  if (!owner || !name || rest.length > 0) {
    throw new Error(`Invalid repo reference: ${value}`);
  }
  return { owner, name };
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function normalizeVersion(tag: string): string {
  return tag.trim().replace(/^v/i, "");
}

function parseVersion(tag: string): { segments: number[]; prerelease: string | null } | null {
  const normalized = normalizeVersion(tag);
  const [core, prerelease] = normalized.split("-", 2);
  const segments = core?.split(".").map((segment) => Number.parseInt(segment, 10));
  if (!segments || segments.length === 0 || segments.some((segment) => Number.isNaN(segment))) {
    return null;
  }
  return {
    segments,
    prerelease: prerelease ?? null,
  };
}

function compareVersions(left: string, right: string): number {
  const leftParsed = parseVersion(left);
  const rightParsed = parseVersion(right);
  if (!leftParsed || !rightParsed) {
    return left.localeCompare(right);
  }

  const longest = Math.max(leftParsed.segments.length, rightParsed.segments.length);
  for (let index = 0; index < longest; index += 1) {
    const leftSegment = leftParsed.segments[index] ?? 0;
    const rightSegment = rightParsed.segments[index] ?? 0;
    if (leftSegment !== rightSegment) {
      return leftSegment - rightSegment;
    }
  }

  if (leftParsed.prerelease === rightParsed.prerelease) {
    return 0;
  }
  if (!leftParsed.prerelease) {
    return 1;
  }
  if (!rightParsed.prerelease) {
    return -1;
  }
  return leftParsed.prerelease.localeCompare(rightParsed.prerelease);
}

async function readConfig(): Promise<WatchConfig> {
  const raw = await readFile(CONFIG_PATH, "utf8");
  return JSON.parse(raw) as WatchConfig;
}

async function githubRequest<T>(
  path: string,
  init?: {
    method?: string;
    body?: unknown;
  },
): Promise<T> {
  const token = process.env.GITHUB_TOKEN;
  const headers = new Headers({
    Accept: "application/vnd.github+json",
    "User-Agent": "t3code-external-watch",
  });

  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  let body: string | undefined;
  if (init?.body !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.body);
  }

  const response = await fetch(`https://api.github.com${path}`, {
    method: init?.method ?? "GET",
    headers,
    body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`GitHub API request failed for ${path}: ${response.status} ${errorText}`);
  }

  return (await response.json()) as T;
}

async function getRepo(repo: RepoRef): Promise<GitHubRepo> {
  return githubRequest<GitHubRepo>(`/repos/${repo.owner}/${repo.name}`);
}

async function compareForkWithUpstream(
  forkRepo: RepoRef,
  forkBranch: string,
  upstreamRepo: RepoRef,
  upstreamBranch: string,
): Promise<GitHubCompare> {
  const basehead = `${forkRepo.owner}:${forkBranch}...${upstreamRepo.owner}:${upstreamBranch}`;
  return githubRequest<GitHubCompare>(
    `/repos/${forkRepo.owner}/${forkRepo.name}/compare/${encodeURIComponent(basehead)}`,
  );
}

async function getLatestRelease(repo: RepoRef): Promise<GitHubRelease> {
  return githubRequest<GitHubRelease>(`/repos/${repo.owner}/${repo.name}/releases/latest`);
}

async function listOpenIssues(repo: RepoRef): Promise<ReadonlyArray<GitHubIssue>> {
  const issues = await githubRequest<GitHubIssue[]>(
    `/repos/${repo.owner}/${repo.name}/issues?state=open&per_page=100`,
  );
  return issues.filter((issue) => issue.pull_request === undefined);
}

function findIssueByMarker(
  issues: ReadonlyArray<GitHubIssue>,
  marker: string,
): GitHubIssue | undefined {
  return issues.find((issue) => issue.body?.includes(marker));
}

async function createIssue(repo: RepoRef, draft: IssueDraft): Promise<void> {
  await githubRequest(`/repos/${repo.owner}/${repo.name}/issues`, {
    method: "POST",
    body: {
      title: draft.title,
      body: draft.body,
    },
  });
}

async function updateIssue(repo: RepoRef, issueNumber: number, draft: IssueDraft): Promise<void> {
  await githubRequest(`/repos/${repo.owner}/${repo.name}/issues/${issueNumber}`, {
    method: "PATCH",
    body: {
      title: draft.title,
      body: draft.body,
    },
  });
}

function buildIssueBody(marker: string, lines: ReadonlyArray<string>): string {
  return [marker, "", ...lines].join("\n");
}

function buildUpstreamIssue(
  forkRepo: RepoRef,
  forkBranch: string,
  config: WatchConfig,
  compare: GitHubCompare,
): IssueDraft | null {
  if (compare.ahead_by <= 0) {
    return null;
  }

  const marker = "<!-- external-watch:upstream -->";
  return {
    marker,
    title: `Sync upstream changes from ${config.upstream.repo}`,
    body: buildIssueBody(marker, [
      `Upstream \`${config.upstream.repo}\` has commits that are not in this fork.`,
      "",
      `- Fork branch: \`${forkBranch}\``,
      `- Upstream branch: \`${config.upstream.branch}\``,
      `- Upstream commits missing here: \`${String(compare.ahead_by)}\``,
      `- Fork only commits: \`${String(compare.behind_by)}\``,
      `- Compare status: \`${compare.status}\``,
      `- Fork head SHA: \`${shortSha(compare.base_commit.sha)}\``,
      `- Merge base SHA: \`${shortSha(compare.merge_base_commit.sha)}\``,
      `- Compare URL: ${compare.html_url}`,
      `- Checked at: \`${new Date().toISOString()}\``,
      "",
      `Update the fork, then close this issue when \`${forkRepo.owner}/${forkRepo.name}\` is aligned.`,
    ]),
  };
}

function buildOmarchyIssue(config: WatchConfig, release: GitHubRelease): IssueDraft | null {
  if (compareVersions(release.tag_name, config.omarchy.trackedVersion) <= 0) {
    return null;
  }

  const marker = "<!-- external-watch:omarchy -->";
  return {
    marker,
    title: `Review Omarchy update ${release.tag_name}`,
    body: buildIssueBody(marker, [
      "Omarchy has a newer release than the version tracked in this repo.",
      "",
      `- Tracked version: \`${config.omarchy.trackedVersion}\``,
      `- Latest release: \`${release.tag_name}\``,
      `- Release URL: ${release.html_url}`,
      `- Published at: \`${release.published_at ?? "unknown"}\``,
      `- Update tracker file: \`${CONFIG_PATH}\``,
      "",
      "Close this issue after the fork is aligned with the new Omarchy release and the tracked version is updated.",
    ]),
  };
}

async function upsertIssue(
  repo: RepoRef,
  issues: ReadonlyArray<GitHubIssue>,
  draft: IssueDraft,
  dryRun: boolean,
): Promise<void> {
  const existingIssue = findIssueByMarker(issues, draft.marker);
  if (!existingIssue) {
    if (dryRun) {
      console.log(`Would create issue: ${draft.title}`);
      return;
    }
    console.log(`Creating issue: ${draft.title}`);
    await createIssue(repo, draft);
    return;
  }

  if (existingIssue.title === draft.title && existingIssue.body === draft.body) {
    console.log(`Issue already current: #${existingIssue.number} ${draft.title}`);
    return;
  }

  if (dryRun) {
    console.log(`Would update issue: #${existingIssue.number} ${draft.title}`);
    return;
  }

  console.log(`Updating issue: #${existingIssue.number} ${draft.title}`);
  await updateIssue(repo, existingIssue.number, draft);
}

async function main(): Promise<void> {
  const dryRun = hasFlag("--dry-run");
  const repositoryName = getFlagValue("--repo") ?? process.env.GITHUB_REPOSITORY;
  if (!repositoryName) {
    throw new Error("Missing repository name. Set GITHUB_REPOSITORY or pass --repo owner/name.");
  }

  if (!dryRun && !process.env.GITHUB_TOKEN) {
    throw new Error("Missing GITHUB_TOKEN.");
  }

  const repo = parseRepoRef(repositoryName);
  const config = await readConfig();
  const upstreamRepo = parseRepoRef(config.upstream.repo);

  const [forkMeta, compare, release, openIssues] = await Promise.all([
    getRepo(repo),
    getRepo(repo).then((forkRepository) =>
      compareForkWithUpstream(repo, forkRepository.default_branch, upstreamRepo, config.upstream.branch),
    ),
    getLatestRelease(parseRepoRef(config.omarchy.repo)),
    listOpenIssues(repo),
  ]);

  const drafts = [
    buildUpstreamIssue(repo, forkMeta.default_branch, config, compare),
    buildOmarchyIssue(config, release),
  ].filter((draft): draft is IssueDraft => draft !== null);

  if (drafts.length === 0) {
    console.log("No external updates detected.");
    return;
  }

  for (const draft of drafts) {
    await upsertIssue(repo, openIssues, draft, dryRun);
  }
}

await main();
