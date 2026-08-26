const COMMENT_MARKER = "<!-- t3-pr-guideline-review -->";

const TEST_FILE_PATTERNS = [
  /^apps\/server\/integration\//,
  /(^|\/)__tests__(\/|$)/,
  /(^|\/)tests?(\/|$)/,
  /\.test\.[^/]+$/,
  /\.spec\.[^/]+$/,
  /\.browser\.[^/]+$/,
  /\.integration\.[^/]+$/,
];

const UI_FILE_PATTERNS = [
  /^apps\/web\/src\/.*\.(?:css|jsx|scss|tsx)$/,
  /^apps\/mobile\/.*\.(?:css|jsx|scss|tsx)$/,
  /^apps\/desktop\/src\/.*\.(?:css|jsx|scss|tsx)$/,
];

const MOTION_PATTERN =
  /(?:@keyframes|\banimation(?:-duration|-name)?\s*:|\btransition(?:-duration|-property)?\s*:|\bLayoutAnimation\b|\bAnimated\.(?:decay|event|loop|parallel|sequence|spring|stagger|timing)\s*\(|\bwithTiming\s*\(|\buseAnimatedStyle\s*\(|\bmotion\.)/i;

const AREA_PATTERNS = [
  [/^apps\/web\//, "web"],
  [/^apps\/mobile\//, "mobile"],
  [/^apps\/desktop\//, "desktop"],
  [/^apps\/server\//, "server"],
  [/^packages\/contracts\//, "contracts"],
  [/^packages\/client-runtime\//, "client runtime"],
  [/^packages\//, "shared package"],
  [/^docs\//, "docs"],
  [/^\.github\//, "GitHub automation"],
];

function stripComments(markdown) {
  return markdown.replace(/<!--[^]*?-->/g, "").trim();
}

function section(markdown, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = markdown.match(
    new RegExp(`^##[ \\t]+${escaped}[ \\t]*\\r?\\n([^]*?)(?=^##[ \\t]+|(?![^]))`, "im"),
  );
  return stripComments(match?.[1] ?? "");
}

function sectionAny(markdown, headings) {
  return headings.map((heading) => section(markdown, heading)).find(Boolean) ?? "";
}

function isTestFile(filename) {
  return TEST_FILE_PATTERNS.some((pattern) => pattern.test(filename));
}

function isUiCandidate(filename) {
  return !isTestFile(filename) && UI_FILE_PATTERNS.some((pattern) => pattern.test(filename));
}

function changedPatch(file) {
  return (file.patch ?? "")
    .split("\n")
    .filter(
      (line) =>
        (line.startsWith("+") && !line.startsWith("+++")) ||
        (line.startsWith("-") && !line.startsWith("---")),
    )
    .join("\n");
}

function isDefiniteUiFile(file) {
  if (!isUiCandidate(file.filename)) return false;
  if (/\.(?:css|scss)$/.test(file.filename)) return true;
  const patch = changedPatch(file);
  return (
    /(?:<[A-Za-z][^>]*\/>|\bclassName\s*=|\bstyle\s*=|\baria-[a-z-]+\s*=|\brole\s*=)/.test(patch) ||
    MOTION_PATTERN.test(patch)
  );
}

function imageCount(markdown) {
  const markdownImages = markdown.match(/!\[[^\]]*\]\([^\s)]+(?:\s+"[^"]*")?\)/gi) ?? [];
  const htmlImages = markdown.match(/<img\b[^>]*>/gi) ?? [];
  const remaining = markdown.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/<img\b[^>]*>/gi, "");
  const bareImageUrls =
    remaining.match(/https?:\/\/[^\s)]+\.(?:avif|gif|jpe?g|png|webp)(?:\?[^\s)]*)?/gi) ?? [];
  return markdownImages.length + htmlImages.length + bareImageUrls.length;
}

function hasVideo(markdown) {
  if (/<video\b[^>]*>/i.test(markdown)) return true;
  if (/https?:\/\/[^\s)]+\.(?:mov|mp4|webm)(?:\?[^\s)]*)?/i.test(markdown)) return true;

  const withoutImages = markdown.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/<img\b[^>]*>/gi, "");
  return /\b(?:demo|recording|video)\b[^\n]{0,80}https:\/\/github\.com\/user-attachments\/assets\/[a-z0-9-]+/i.test(
    withoutImages,
  );
}

function hasRepositoryContextLink(markdown, repository) {
  const escaped = repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`https://github\\.com/${escaped}/(?:issues|discussions)/\\d+`, "i").test(
    markdown,
  );
}

function hasDiscussionLink(markdown, repository) {
  const escaped = repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`https://github\\.com/${escaped}/discussions/\\d+`, "i").test(markdown);
}

function isFeaturePull(title) {
  return /^(?:feat|feature)(?:\([^)]*\))?[!:]/i.test(title.trim());
}

function hasMaintainerContextStatement(markdown) {
  return /\b(?:maintainer[- ](?:approved|directed|requested)|requested by (?:a )?maintainer)\b/i.test(
    markdown,
  );
}

function parseVouchedUsers(contents) {
  return new Set(
    contents
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^github:[^\s#]+$/i.test(line))
      .map((line) => line.slice("github:".length).toLowerCase()),
  );
}

function isTrustedPull(pull, vouchedUsers) {
  if (["COLLABORATOR", "MEMBER", "OWNER"].includes(pull.author_association)) return true;
  if (pull.labels?.some((label) => label.name === "vouch:trusted")) return true;
  return vouchedUsers.has(pull.user?.login?.toLowerCase());
}

function isBotPull(pull) {
  return pull.user?.type === "Bot" || pull.user?.login?.endsWith("[bot]");
}

function explainsNoVisualChange(markdown) {
  const evidence = section(markdown, "UI Changes");
  return /\b(?:no (?:user-facing |visible )?(?:UI|visual)(?: or interaction)? changes?|(?:screenshots?|UI changes?) (?:are |is )?not applicable)\b/i.test(
    evidence,
  );
}

function explainsNoInteractionChange(markdown) {
  const evidence = section(markdown, "UI Changes");
  return (
    /\b(?:no (?:visual or )?(?:motion|interaction) changes?|(?:motion|interaction)(?:s| UI)? (?:is|are) unchanged)\b/i.test(
      evidence,
    ) || /\bvideo is not applicable\b/i.test(evidence)
  );
}

function effectiveChangedLines(files) {
  const totals = files.reduce(
    (result, file) => {
      const changed = (file.additions ?? 0) + (file.deletions ?? 0);
      if (isTestFile(file.filename)) result.test += changed;
      else result.nonTest += changed;
      return result;
    },
    { nonTest: 0, test: 0 },
  );

  return {
    ...totals,
    effective: totals.nonTest === 0 ? totals.test : totals.nonTest,
  };
}

function changedAreas(files) {
  const areas = new Set();
  for (const file of files) {
    if (isTestFile(file.filename)) continue;
    const match = AREA_PATTERNS.find(([pattern]) => pattern.test(file.filename));
    if (match) areas.add(match[1]);
  }
  return [...areas];
}

function finding(code, severity, message) {
  return { code, severity, message };
}

function evaluatePull({
  pull,
  files,
  repository,
  vouchedUsers = new Set(),
  vouchedStandardAvailable = false,
}) {
  const body = pull.body ?? "";
  const whatChanged = section(body, "What Changed");
  const why = section(body, "Why");
  const scopeAndNonGoals = section(body, "Scope and Non-Goals");
  const affectedAreas = section(body, "Affected Areas");
  const validation = section(body, "Validation");
  const risksAndUntested = sectionAny(body, [
    "Risks and Untested Paths",
    "Risks and Limitations",
    "Risks",
    "Limitations",
  ]);
  const lines = effectiveChangedLines(files);
  const lineKind = lines.nonTest === 0 && lines.test > 0 ? "test" : "non-test";
  const areas = changedAreas(files);
  const contextLink = hasRepositoryContextLink(body, repository);
  const discussionLink = hasDiscussionLink(body, repository);
  const maintainerContext = hasMaintainerContextStatement(body);
  const uiCandidates = files.filter((file) => isUiCandidate(file.filename));
  const uiFiles = uiCandidates.filter((file) => isDefiniteUiFile(file));
  const uninspectableUiFiles = uiCandidates.filter((file) => file.patch === undefined);
  const trustedPull = isTrustedPull(pull, vouchedUsers);
  const hasMotionChange = uiFiles.some((file) => MOTION_PATTERN.test(changedPatch(file)));
  const findings = [];

  if (!whatChanged) {
    findings.push(
      finding(
        "missing-what-changed",
        "blocking",
        "Fill in `## What Changed` with the exact behavior this PR changes.",
      ),
    );
  }
  if (!why) {
    findings.push(
      finding(
        "missing-why",
        "blocking",
        "Fill in `## Why` with the concrete problem and why this change should exist.",
      ),
    );
  }

  if (trustedPull && vouchedStandardAvailable && !scopeAndNonGoals) {
    findings.push(
      finding(
        "missing-scope-and-non-goals",
        "blocking",
        "The vouched-contributor handoff requires explicit scope. Fill in `## Scope and Non-Goals` with what this PR intentionally leaves unchanged or defers.",
      ),
    );
  }
  const surfaceEvidence = `${scopeAndNonGoals}\n${risksAndUntested}`;
  if (
    trustedPull &&
    vouchedStandardAvailable &&
    !affectedAreas &&
    !/\b(?:clients?|providers?|platforms?|contracts?|connection modes?|surfaces?)\b/i.test(
      surfaceEvidence,
    )
  ) {
    findings.push(
      finding(
        "missing-affected-areas",
        "blocking",
        "Name the applicable clients, providers, platforms, contracts, and connection modes in `## Affected Areas` or the scope/risk sections; include unsupported paths.",
      ),
    );
  }
  if (trustedPull && vouchedStandardAvailable && !validation) {
    findings.push(
      finding(
        "missing-validation",
        "blocking",
        "Fill in `## Validation` with the exact focused commands or direct checks and their results.",
      ),
    );
  }
  if (trustedPull && vouchedStandardAvailable && !risksAndUntested) {
    findings.push(
      finding(
        "missing-risks-and-untested",
        "blocking",
        "Fill in `## Risks and Untested Paths`; say `None known` only when that is the honest result.",
      ),
    );
  }
  if (uiFiles.length > 0 && imageCount(body) < 2 && !explainsNoVisualChange(body)) {
    findings.push(
      finding(
        "missing-ui-images",
        "blocking",
        "This diff touches visible client files. Add both a before image and an after image to `## UI Changes`.",
      ),
    );
  }
  if (hasMotionChange && !hasVideo(body) && !explainsNoInteractionChange(body)) {
    findings.push(
      finding(
        "missing-interaction-video",
        "blocking",
        "The diff contains motion or transition code. Add a short interaction video.",
      ),
    );
  }

  const nonProductAreas = new Set(["docs", "GitHub automation"]);
  const onlyNonProductAreas = areas.length > 0 && areas.every((area) => nonProductAreas.has(area));
  if (!trustedPull && isFeaturePull(pull.title) && !onlyNonProductAreas && !discussionLink) {
    if (maintainerContext) {
      findings.push(
        finding(
          "private-feature-context",
          "advisory",
          "This feature is described as maintainer-directed without a public Ideas link. A maintainer must verify that context.",
        ),
      );
    } else {
      findings.push(
        finding(
          "missing-feature-discussion",
          "blocking",
          "Feature proposals belong in an Ideas discussion. Link the repository discussion where this direction was raised, or state that a maintainer directed the work without adding private routing details.",
        ),
      );
    }
  } else if (!trustedPull && lines.effective >= 100 && !contextLink) {
    findings.push(
      finding(
        "missing-nontrivial-context",
        "advisory",
        `This change has ${lines.effective.toLocaleString("en-US")} ${lineKind} changed lines. Link the repository bug issue or Ideas discussion that established the scope first.`,
      ),
    );
  }

  if (lines.effective >= 1_000) {
    findings.push(
      finding(
        "xxl-change",
        "advisory",
        "The contribution guide says 1,000+ line PRs are likely to be closed quickly. A maintainer must decide whether the change can be split.",
      ),
    );
  } else if (lines.effective >= 100) {
    findings.push(
      finding(
        "large-change",
        "advisory",
        `This change has ${lines.effective.toLocaleString("en-US")} ${lineKind} changed lines, outside the project's preferred small-PR range. A maintainer should confirm that the scope is still reviewable.`,
      ),
    );
  }

  if (areas.length >= 3) {
    findings.push(
      finding(
        "many-areas",
        "advisory",
        `The diff crosses ${areas.length} project areas. Check that it still delivers one outcome without unrelated fixes.`,
      ),
    );
  }

  if (Number.isSafeInteger(pull.changed_files) && pull.changed_files > files.length) {
    findings.push(
      finding(
        "incomplete-file-list",
        "advisory",
        `GitHub returned ${files.length.toLocaleString("en-US")} of ${pull.changed_files.toLocaleString("en-US")} changed files. A maintainer must inspect the full diff.`,
      ),
    );
  }

  if (uninspectableUiFiles.length > 0) {
    findings.push(
      finding(
        "uninspectable-ui-patch",
        "advisory",
        `GitHub omitted patch text for ${uninspectableUiFiles.length.toLocaleString("en-US")} client file${uninspectableUiFiles.length === 1 ? "" : "s"}. A maintainer must check whether visual or interaction evidence applies.`,
      ),
    );
  }

  const hasBlocking = findings.some((entry) => entry.severity === "blocking");
  const hasAdvisory = findings.some((entry) => entry.severity === "advisory");
  const status = hasBlocking ? "needs_work" : hasAdvisory ? "manual_review" : "pass";

  return {
    status,
    findings,
    metrics: {
      effectiveChangedLines: lines.effective,
      nonTestChangedLines: lines.nonTest,
      testChangedLines: lines.test,
      lineKind,
      areas,
      uiFileCount: uiFiles.length,
      hasMotionChange,
      trustedPull,
    },
  };
}

function renderComment(result, { repository, policyRevision, vouchedStandardAvailable = false }) {
  const policyUrl = `https://github.com/${repository}/blob/${policyRevision}/CONTRIBUTING.md`;
  const vouchedPolicyUrl = `https://github.com/${repository}/blob/${policyRevision}/CONTRIBUTING_VOUCHED.md`;
  const title = {
    needs_work: "Needs work before maintainer review",
    manual_review: "Human judgment needed",
    pass: "Looks ready for a maintainer to inspect",
  }[result.status];
  const icon = { blocking: "❌", advisory: "⚠️" };
  const detail =
    result.findings.length === 0
      ? ["- ✅ The objective checks found no missing explanation, context, size, or evidence item."]
      : result.findings.map((entry) => `- ${icon[entry.severity]} ${entry.message}`);
  const areas = result.metrics.areas.length > 0 ? result.metrics.areas.join(", ") : "uncategorized";
  const policies =
    result.metrics.trustedPull && vouchedStandardAvailable
      ? `[CONTRIBUTING.md](${policyUrl}) and [CONTRIBUTING_VOUCHED.md](${vouchedPolicyUrl})`
      : `[CONTRIBUTING.md](${policyUrl})`;

  return [
    COMMENT_MARKER,
    "## Contribution sniff test",
    "",
    `### ${title}`,
    "",
    ...detail,
    "",
    `Observed by this advisory check: ${result.metrics.effectiveChangedLines.toLocaleString("en-US")} ${result.metrics.lineKind} changed lines, ${areas}. The repository's \`size:*\` workflow may report fewer lines because it also ignores whitespace-only changes.`,
    "",
    `This advisory check applies ${policies}. It does not approve, reject, or replace maintainer review. It deliberately leaves product direction, whether the PR mixes concerns, and whether the implementation is correct to a person.`,
  ].join("\n");
}

async function upsertComment(github, context, pullNumber, body) {
  const comments = await github.paginate(github.rest.issues.listComments, {
    ...context.repo,
    issue_number: pullNumber,
    per_page: 100,
  });
  const existing = comments.find(
    (comment) =>
      comment.user?.login === "github-actions[bot]" && comment.body?.includes(COMMENT_MARKER),
  );

  if (existing?.body === body) return "unchanged";
  if (existing) {
    await github.rest.issues.updateComment({
      ...context.repo,
      comment_id: existing.id,
      body,
    });
    return "updated";
  }

  await github.rest.issues.createComment({
    ...context.repo,
    issue_number: pullNumber,
    body,
  });
  return "created";
}

async function reviewPull({
  github,
  context,
  core,
  policyRevision = context.sha,
  vouchedUsers = new Set(),
  vouchedStandardAvailable = false,
}) {
  const eventPull = context.payload.pull_request;
  const expectedHeadSha = eventPull.head.sha;
  const { owner, repo } = context.repo;
  const pullNumber = eventPull.number;
  const { data: pull } = await github.rest.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
  });

  if (pull.head.sha !== expectedHeadSha) {
    core.info(`Skipping stale PR head ${expectedHeadSha}; current head is ${pull.head.sha}.`);
    return { published: false, reason: "stale" };
  }

  if (isBotPull(pull)) {
    core.info(`Skipping bot-authored PR from ${pull.user.login}.`);
    return { published: false, reason: "bot" };
  }

  if (pull.draft) {
    core.info(`Skipping draft PR #${pullNumber}.`);
    return { published: false, reason: "draft" };
  }

  const files = await github.paginate(github.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });
  const result = evaluatePull({
    pull,
    files,
    repository: `${owner}/${repo}`,
    vouchedUsers,
    vouchedStandardAvailable,
  });
  const body = renderComment(result, {
    repository: `${owner}/${repo}`,
    policyRevision: policyRevision ?? pull.base.sha,
    vouchedStandardAvailable,
  });

  const { data: currentPull } = await github.rest.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
  });
  if (currentPull.head.sha !== expectedHeadSha) {
    core.info(
      `Skipping stale PR head ${expectedHeadSha}; current head is ${currentPull.head.sha}.`,
    );
    return { published: false, reason: "stale" };
  }

  const publication = await upsertComment(github, context, pullNumber, body);
  core.info(`PR #${pullNumber}: ${result.status}; comment ${publication}.`);
  return { published: true, publication, result };
}

module.exports = {
  COMMENT_MARKER,
  effectiveChangedLines,
  evaluatePull,
  hasVideo,
  imageCount,
  parseVouchedUsers,
  renderComment,
  reviewPull,
  section,
  sectionAny,
  upsertComment,
};
