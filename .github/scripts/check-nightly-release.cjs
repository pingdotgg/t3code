const MINIMUM_RELEASE_GAP_MS = 6 * 60 * 60 * 1000;

// Runs after the workflow acquires the nightly concurrency lock.
async function shouldReleaseNightly({ github, context, core, now = Date.now() }) {
  const releases = await github.paginate(github.rest.repos.listReleases, {
    ...context.repo,
    per_page: 100,
  });
  const lastNightly = releases
    .filter(
      (release) =>
        !release.draft &&
        release.published_at &&
        (/^v.*-nightly\./.test(release.tag_name) || release.tag_name.startsWith("nightly-v")),
    )
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0];

  if (!lastNightly) {
    core.info("No published nightly found. Proceeding with release.");
    return true;
  }

  if (now - Date.parse(lastNightly.published_at) < MINIMUM_RELEASE_GAP_MS) {
    core.info(`Nightly ${lastNightly.tag_name} was published less than six hours ago. Skipping.`);
    return false;
  }

  const { data: comparison } = await github.rest.repos.compareCommitsWithBasehead({
    ...context.repo,
    basehead: `${lastNightly.tag_name}...${context.sha}`,
    per_page: 1,
  });
  if (comparison.status !== "ahead") {
    core.info(
      `Candidate commit is ${comparison.status} relative to ${lastNightly.tag_name}. Skipping.`,
    );
    return false;
  }

  core.info(`New commits since ${lastNightly.tag_name}, and the six-hour gap has passed.`);
  return true;
}

module.exports = { shouldReleaseNightly };
