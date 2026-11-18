const sha = /^[0-9a-f]{40}$/;

function selectPaths(paths) {
  const musl = paths.some(
    (path) =>
      path.startsWith("apps/conn-server/") ||
      path === ".github/workflows/conn-server-ci.yml" ||
      path === ".github/workflows/conn-server-checks.yml",
  );
  const checks = musl || paths.some((path) => /^(apps\/(server|web)|packages)\//.test(path));
  return { checks, musl };
}

async function select({ github, context, core, diff }) {
  const source = context.payload.workflow_run;
  const { owner, repo } = context.repo;
  const { data: suite } = await github.rest.checks.getSuite({
    owner,
    repo,
    check_suite_id: source.check_suite_id,
  });
  const before = suite.before;
  const after = source.head_sha;
  if (
    suite.repository.id !== source.head_repository.id ||
    suite.head_branch !== "main" ||
    suite.head_sha !== after ||
    suite.after !== after ||
    !sha.test(before) ||
    !sha.test(after)
  ) {
    throw new Error("The original main push range does not match the completed CI run");
  }
  core.setOutput("source_sha", after);
  core.info(`Selecting Conn Server checks for ${before}..${after} after CI ${source.id}`);

  let selection;
  try {
    const { data: comparison } = await github.rest.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead: `${before}...${after}`,
      per_page: 1,
    });
    if (comparison.total_commits > 1000) {
      selection = { checks: true, musl: true };
    } else if (comparison.merge_base_commit.sha === before && Array.isArray(comparison.files)) {
      selection = selectPaths(
        comparison.files.flatMap(({ filename, previous_filename }) =>
          previous_filename ? [previous_filename, filename] : [filename],
        ),
      );
    } else {
      // REST compares from the merge base. The original push compares the two tips.
      selection = selectPaths(await diff(before, after));
    }
  } catch (error) {
    // Match Actions' push behavior when it cannot generate a diff.
    core.warning(`Could not resolve the push diff: ${error.message}. Running both checks.`);
    selection = { checks: true, musl: true };
  }
  for (const [name, enabled] of Object.entries(selection)) {
    core.setOutput(name, String(enabled));
  }
}

module.exports = { select };
