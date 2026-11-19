const PRODUCT_PATHS = [
  /^apps\/(?:server|web|desktop|mobile)\//u,
  /^packages\//u,
  /^native\//u,
  /^scripts\//u,
  /^packaging\//u,
  /^patches\//u,
  /^\.github\/patches\//u,
  /^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/u,
];

function isPatchSubject(subject) {
  return /^patch: \S(?:.*\S)?$/u.test(subject.trimEnd());
}

function validatePatchIntent({ files, title, body, commits = [] }) {
  const sourceFiles = files.filter((file) => PRODUCT_PATHS.some((pattern) => pattern.test(file)));
  if (sourceFiles.length === 0) return { sourceFiles, errors: [] };

  const include = /^-\s+\[x\]\s+Include this change in patched nightlies\s*$/imu.test(body);
  const exclude = /^-\s+\[x\]\s+Keep this change out of patched nightlies\s*$/imu.test(body);
  const errors = [];

  if (include === exclude) {
    errors.push("Choose exactly one Patched nightly option in the pull request description.");
  }
  if (include && !isPatchSubject(title)) {
    errors.push(
      "Included nightly patches must use the exact PR title format `patch: description`.",
    );
  }
  if (include && commits.length === 0) {
    errors.push("No commits were returned to verify the nightly patch prefix.");
  }
  if (include && commits.some((subject) => !isPatchSubject(subject.split(/\r?\n/u, 1)[0] ?? ""))) {
    errors.push(
      "Every commit in an included nightly patch PR must use the exact `patch: description` subject.",
    );
  }
  if (
    exclude &&
    (isPatchSubject(title) ||
      commits.some((subject) => isPatchSubject(subject.split(/\r?\n/u, 1)[0] ?? "")))
  ) {
    errors.push(
      "A `patch: description` title or commit is selected for nightly replay; choose the include option or rename it.",
    );
  }

  if (errors.length > 0) {
    const examples = sourceFiles.slice(0, 5).join(", ");
    errors.push(
      `Product files detected: ${examples}${sourceFiles.length > 5 ? `, and ${sourceFiles.length - 5} more` : ""}.`,
    );
  }
  return { sourceFiles, errors };
}

module.exports = { validatePatchIntent };
