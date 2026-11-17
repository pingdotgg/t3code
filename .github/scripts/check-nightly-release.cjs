const MINIMUM_RELEASE_GAP_MS = 6 * 60 * 60 * 1000;

function repositoryDefaultBranch(context) {
  const branch = context.payload.repository?.default_branch;
  if (!branch) {
    throw new Error("GitHub did not provide the repository default branch.");
  }
  return branch;
}

async function assertCommitOnDefaultBranch({ github, context, sha }) {
  const defaultBranch = repositoryDefaultBranch(context);
  const { data: comparison } = await github.rest.repos.compareCommitsWithBasehead({
    ...context.repo,
    basehead: `${sha}...${defaultBranch}`,
    per_page: 1,
  });
  if (comparison.status !== "ahead" && comparison.status !== "identical") {
    throw new Error(
      `Release commit ${sha} is not contained in ${defaultBranch} (${comparison.status}).`,
    );
  }
}

async function assertReleaseSource({ github, context, releaseChannel }) {
  if (releaseChannel === "preview") return;
  if (releaseChannel !== "stable" && releaseChannel !== "nightly") {
    throw new Error(`Unsupported release channel: ${releaseChannel}`);
  }

  const defaultBranch = repositoryDefaultBranch(context);
  if (context.eventName === "workflow_dispatch" && context.ref !== `refs/heads/${defaultBranch}`) {
    throw new Error(
      `${releaseChannel} releases must be dispatched from ${defaultBranch}; selected ${context.ref}. Use the preview channel for branch builds.`,
    );
  }

  await assertCommitOnDefaultBranch({ github, context, sha: context.sha });
}

const isNightlyTag = (tag) => /^v.*-nightly\./.test(tag) || tag.startsWith("nightly-v");

// Only the three fields the gate reads. The REST list also returns every asset,
// which made a full scan tens of megabytes.
const RELEASES_QUERY = `
  query ($owner: String!, $repo: String!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      releases(first: 100, after: $cursor, orderBy: { field: CREATED_AT, direction: DESC }) {
        pageInfo { hasNextPage endCursor }
        nodes { tagName isDraft publishedAt }
      }
    }
  }
`;

// Returns the nightly with the newest publishedAt. Release order follows the
// tagged commit date, not publication, so every page is read unless `isSettled`
// says the newest nightly seen so far already decides the caller's answer.
async function findLatestNightly({ github, context, isSettled = () => false }) {
  let latest;
  let cursor = null;
  do {
    const { repository } = await github.graphql(RELEASES_QUERY, { ...context.repo, cursor });
    const { nodes, pageInfo } = repository.releases;
    for (const release of nodes) {
      if (release.isDraft || !release.publishedAt || !isNightlyTag(release.tagName)) continue;
      if (!latest || Date.parse(release.publishedAt) > Date.parse(latest.publishedAt)) {
        latest = release;
      }
    }
    if (latest && isSettled(latest)) return latest;
    cursor = pageInfo.hasNextPage ? pageInfo.endCursor : null;
  } while (cursor);
  return latest;
}

async function shouldReleaseNightly({ github, context, core, now = Date.now() }) {
  const isInGap = (release) => now - Date.parse(release.publishedAt) < MINIMUM_RELEASE_GAP_MS;
  // Any nightly inside the gap means the newest one is too, so stop reading.
  const lastNightly = await findLatestNightly({ github, context, isSettled: isInGap });

  if (!lastNightly) {
    core.info("No published nightly found. Proceeding with release.");
    return true;
  }

  const tag = lastNightly.tagName;
  if (isInGap(lastNightly)) {
    core.info(`Nightly ${tag} was published less than six hours ago. Skipping.`);
    return false;
  }

  const { data: comparison } = await github.rest.repos.compareCommitsWithBasehead({
    ...context.repo,
    basehead: `${tag}...${context.sha}`,
    per_page: 1,
  });
  if (comparison.status !== "ahead") {
    core.info(`Candidate commit is ${comparison.status} relative to ${tag}. Skipping.`);
    return false;
  }

  core.info(`New commits since ${tag}, and the six-hour gap has passed.`);
  return true;
}

async function resolveLatestNightlyCommit({ github, context, core }) {
  const lastNightly = await findLatestNightly({ github, context });
  if (!lastNightly) {
    throw new Error("No published nightly found. Stable releases build the latest nightly commit.");
  }

  const tag = lastNightly.tagName;
  const { data: commit } = await github.rest.repos.getCommit({ ...context.repo, ref: tag });
  const version = /^(?:nightly-)?v(\d+\.\d+\.\d+)-nightly\./.exec(tag)?.[1];
  if (!version) {
    throw new Error(`Cannot derive a stable version from nightly tag ${tag}.`);
  }

  core.info(`Latest nightly ${tag} shipped ${commit.sha} as a preview of ${version}.`);
  return { tag, sha: commit.sha, version };
}

// The two places a nightly install looks for an update: the `update-feed` pointer, and
// releases.atom, which holds the 10 newest git tags of any kind. Older installs take the first
// nightly in the feed. Reports what each names beside the newest published nightly.
async function readNightlyUpdateFeed({ github, context, fetch = globalThis.fetch }) {
  const latest = await findLatestNightly({ github, context });
  if (!latest) return {};

  const base = `https://github.com/${context.repo.owner}/${context.repo.repo}`;
  // Only a missing or malformed pointer is stale. Rewriting deletes the old file first, so a
  // GitHub outage must not look like one.
  // Node waits five minutes for a stalled response, which is this job's whole time limit.
  const signal = () => AbortSignal.timeout(30_000);
  const pointer = await fetch(`${base}/releases/download/update-feed/nightly.json`, {
    signal: signal(),
  });
  if (!pointer.ok && pointer.status !== 404) {
    throw new Error(`The update-feed pointer answered HTTP ${pointer.status}.`);
  }
  let pointerTag;
  if (pointer.ok) {
    // A body that fails to arrive throws here; only one that is not JSON counts as malformed.
    const body = await pointer.text();
    try {
      pointerTag = JSON.parse(body)?.tag_name;
    } catch {}
  }

  // An unreadable feed leaves `feedTags` unset, so the pointer is still repaired. An error page
  // can answer HTTP 200, so only an Atom document counts as read.
  let feedTags;
  try {
    const feed = await fetch(`${base}/releases.atom`, { signal: signal() });
    const body = feed.ok ? await feed.text() : "";
    if (/<feed[\s>]/.test(body)) {
      feedTags = Array.from(body.matchAll(/href="[^"]*\/releases\/tag\/([^"]+)"/g), (match) =>
        decodeURIComponent(match[1]),
      );
    }
  } catch {}
  const feedNightly = feedTags?.find((tag) => /^v?\d+\.\d+\.\d+-nightly\./.test(tag));

  return { tag: latest.tagName, pointerTag, feedNightly, feedTags };
}

module.exports = {
  assertCommitOnDefaultBranch,
  assertReleaseSource,
  shouldReleaseNightly,
  resolveLatestNightlyCommit,
  readNightlyUpdateFeed,
};
