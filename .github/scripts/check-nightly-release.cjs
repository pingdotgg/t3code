const MINIMUM_RELEASE_GAP_MS = 6 * 60 * 60 * 1000;
// Waits before each retry of a read that failed with a 5xx or a network error.
const RETRY_DELAYS_MS = [2_000, 5_000, 10_000];

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Octokit reports network failures as status 500, so this also covers resets.
// Auth, permission, validation, and GraphQL query errors fail at once.
async function withRetry(label, request, { core, sleep = defaultSleep } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await request();
    } catch (error) {
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !(error?.status >= 500)) throw error;
      core?.warning(`${label} failed with status ${error.status}. Retrying in ${delay / 1000}s.`);
      await sleep(delay);
    }
  }
}

function repositoryDefaultBranch(context) {
  const branch = context.payload.repository?.default_branch;
  if (!branch) {
    throw new Error("GitHub did not provide the repository default branch.");
  }
  return branch;
}

async function assertCommitOnDefaultBranch({ github, context, core, sleep, sha }) {
  const defaultBranch = repositoryDefaultBranch(context);
  const basehead = `${sha}...${defaultBranch}`;
  const { data: comparison } = await withRetry(
    `Compare ${basehead}`,
    () => github.rest.repos.compareCommitsWithBasehead({ ...context.repo, basehead, per_page: 1 }),
    { core, sleep },
  );
  if (comparison.status !== "ahead" && comparison.status !== "identical") {
    throw new Error(
      `Release commit ${sha} is not contained in ${defaultBranch} (${comparison.status}).`,
    );
  }
}

async function assertReleaseSource({ github, context, core, sleep, releaseChannel }) {
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

  await assertCommitOnDefaultBranch({ github, context, core, sleep, sha: context.sha });
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
async function findLatestNightly({ github, context, core, sleep, isSettled = () => false }) {
  let latest;
  let cursor = null;
  do {
    const { repository } = await withRetry(
      "List releases",
      () => github.graphql(RELEASES_QUERY, { ...context.repo, cursor }),
      { core, sleep },
    );
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

async function shouldReleaseNightly({ github, context, core, sleep, now = Date.now() }) {
  const isInGap = (release) => now - Date.parse(release.publishedAt) < MINIMUM_RELEASE_GAP_MS;
  // Any nightly inside the gap means the newest one is too, so stop reading.
  const lastNightly = await findLatestNightly({ github, context, core, sleep, isSettled: isInGap });

  if (!lastNightly) {
    core.info("No published nightly found. Proceeding with release.");
    return true;
  }

  const tag = lastNightly.tagName;
  if (isInGap(lastNightly)) {
    core.info(`Nightly ${tag} was published less than six hours ago. Skipping.`);
    return false;
  }

  const basehead = `${tag}...${context.sha}`;
  const { data: comparison } = await withRetry(
    `Compare ${basehead}`,
    () => github.rest.repos.compareCommitsWithBasehead({ ...context.repo, basehead, per_page: 1 }),
    { core, sleep },
  );
  if (comparison.status !== "ahead") {
    core.info(`Candidate commit is ${comparison.status} relative to ${tag}. Skipping.`);
    return false;
  }

  core.info(`New commits since ${tag}, and the six-hour gap has passed.`);
  return true;
}

async function resolveLatestNightlyCommit({ github, context, core, sleep }) {
  const lastNightly = await findLatestNightly({ github, context, core, sleep });
  if (!lastNightly) {
    throw new Error("No published nightly found. Stable releases build the latest nightly commit.");
  }

  const tag = lastNightly.tagName;
  const { data: commit } = await withRetry(
    `Read commit ${tag}`,
    () => github.rest.repos.getCommit({ ...context.repo, ref: tag }),
    { core, sleep },
  );
  const version = /^(?:nightly-)?v(\d+\.\d+\.\d+)-nightly\./.exec(tag)?.[1];
  if (!version) {
    throw new Error(`Cannot derive a stable version from nightly tag ${tag}.`);
  }

  core.info(`Latest nightly ${tag} shipped ${commit.sha} as a preview of ${version}.`);
  return { tag, sha: commit.sha, version };
}

module.exports = {
  assertCommitOnDefaultBranch,
  assertReleaseSource,
  shouldReleaseNightly,
  resolveLatestNightlyCommit,
};
