const fs = require("node:fs");
const path = require("node:path");

const ARTIFACT_NAME = "thread-transfer-results";
const RESULT_FILE = "thread-transfer-result.json";
const COMMENT_MARKER = "<!-- t3-thread-transfer-report -->";
const PROVIDERS = ["codex", "claudeAgent"];
const OBSERVED_KEYS = [
  "totalWireBytes",
  "threadSnapshotWireBytes",
  "threadSnapshotDecodedBytes",
  "measuredTurnWebSocketWireBytes",
  "measuredTurnWebSocketDecodedBytes",
  "measuredTurnWebSocketMessages",
];
const CEILING_KEYS = [
  "totalWireBytes",
  "threadSnapshotWireBytes",
  "measuredTurnWebSocketWireBytes",
  "measuredTurnWebSocketDecodedBytes",
  "measuredTurnWebSocketMessages",
];
const SCENARIO_KEYS = [
  "id",
  "historyTurns",
  "historyCommandToolsPerTurn",
  "historyMcpResultBytes",
  "measuredCommandTools",
  "measuredMcpResultBytes",
];

function resultShaMarker(sha) {
  return `<!-- t3-thread-transfer-result-sha:${sha} -->`;
}

function assertObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertExactKeys(value, expected, label) {
  assertObject(value, label);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unexpected fields`);
  }
}

function assertMetric(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000) {
    throw new Error(`${label} must be a non-negative safe integer below 1,000,000,000`);
  }
}

function validateResult(value) {
  assertExactKeys(value, ["schemaVersion", "scenario", "providers"], "result");
  if (value.schemaVersion !== 1) {
    throw new Error("result.schemaVersion must be 1");
  }

  assertExactKeys(value.scenario, SCENARIO_KEYS, "result.scenario");
  if (value.scenario.id !== "thread-transfer-v1") {
    throw new Error("result.scenario.id is not supported");
  }
  for (const key of SCENARIO_KEYS.slice(1)) {
    assertMetric(value.scenario[key], `result.scenario.${key}`);
  }

  assertExactKeys(value.providers, PROVIDERS, "result.providers");
  for (const provider of PROVIDERS) {
    const entry = value.providers[provider];
    assertExactKeys(entry, ["observed", "ceiling"], `result.providers.${provider}`);
    assertExactKeys(entry.observed, OBSERVED_KEYS, `result.providers.${provider}.observed`);
    assertExactKeys(entry.ceiling, CEILING_KEYS, `result.providers.${provider}.ceiling`);
    for (const key of OBSERVED_KEYS) {
      assertMetric(entry.observed[key], `result.providers.${provider}.observed.${key}`);
    }
    for (const key of CEILING_KEYS) {
      assertMetric(entry.ceiling[key], `result.providers.${provider}.ceiling.${key}`);
    }
  }

  return value;
}

function readResult(directory) {
  if (!directory) return undefined;
  const file = path.join(directory, RESULT_FILE);
  if (!fs.existsSync(file)) return undefined;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > 64 * 1_024) {
    throw new Error("thread transfer result must be a regular file smaller than 64 KiB");
  }
  return validateResult(JSON.parse(fs.readFileSync(file, "utf8")));
}

function formatBytes(bytes) {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes >= 1_024 * 1_024) return `${(bytes / 1_024 / 1_024).toFixed(2)} MiB`;
  return `${(bytes / 1_024).toFixed(1)} KiB`;
}

function formatValue(value, kind) {
  return kind === "messages" ? value.toLocaleString("en-US") : formatBytes(value);
}

function formatImpact(current, baseline, kind) {
  if (baseline === undefined) return "—";
  const delta = current - baseline;
  const prefix = delta > 0 ? "+" : delta < 0 ? "−" : "";
  const magnitude = formatValue(Math.abs(delta), kind);
  const percent =
    baseline === 0 ? "" : ` (${prefix}${Math.abs((delta / baseline) * 100).toFixed(1)}%)`;
  return `${prefix}${magnitude}${percent}`;
}

function sameScenario(left, right) {
  return SCENARIO_KEYS.every((key) => left[key] === right[key]);
}

const METRICS = [
  { key: "totalWireBytes", label: "Total thread wire", kind: "bytes" },
  { key: "threadSnapshotWireBytes", label: "Thread snapshot wire", kind: "bytes" },
  {
    key: "measuredTurnWebSocketWireBytes",
    label: "Live turn WebSocket wire",
    kind: "bytes",
  },
  {
    key: "measuredTurnWebSocketDecodedBytes",
    label: "Live turn WebSocket decoded",
    kind: "bytes",
  },
  { key: "measuredTurnWebSocketMessages", label: "Live turn messages", kind: "messages" },
];

function renderComment(input) {
  const current = input.current;
  const baseline = input.baseline;
  const comparable = baseline !== undefined && sameScenario(current.scenario, baseline.scenario);
  const rows = [];
  const ceilingChanges = [];
  let failed = false;

  for (const provider of PROVIDERS) {
    for (const metric of METRICS) {
      const observed = current.providers[provider].observed[metric.key];
      const ceiling = current.providers[provider].ceiling[metric.key];
      const baselineObserved = comparable
        ? baseline.providers[provider].observed[metric.key]
        : undefined;
      const pass = observed <= ceiling;
      failed ||= !pass;
      rows.push(
        `| ${provider === "codex" ? "Codex" : "Claude"} | ${metric.label} | ${baselineObserved === undefined ? "—" : formatValue(baselineObserved, metric.kind)} | ${formatValue(observed, metric.kind)} | ${formatImpact(observed, baselineObserved, metric.kind)} | ${formatValue(ceiling, metric.kind)} | ${pass ? "✅" : "❌"} |`,
      );

      if (baseline && baseline.providers[provider].ceiling[metric.key] !== ceiling) {
        ceilingChanges.push(
          `- ${provider === "codex" ? "Codex" : "Claude"} ${metric.label}: ${formatValue(baseline.providers[provider].ceiling[metric.key], metric.kind)} → ${formatValue(ceiling, metric.kind)}`,
        );
      }
    }
  }

  const baselineLink = input.baselineRun
    ? `[\`${input.baselineRun.sha.slice(0, 7)}\`](${input.baselineRun.url})`
    : "unavailable";
  const currentLink = `[\`${input.currentRun.sha.slice(0, 7)}\`](${input.currentRun.url})`;
  const notices = [];
  if (!baseline) {
    notices.push(
      "> ℹ️ No successful `main` baseline artifact is available yet. This run establishes the initial measurement.",
    );
  } else if (!comparable) {
    notices.push(
      "> ⚠️ The thread fixture changed, so impact percentages are not directly comparable to the `main` baseline.",
    );
  } else if (!input.baselineRun.matchesBase) {
    notices.push(
      "> ℹ️ The exact PR base did not have a successful artifact. Baseline uses the latest successful `main` measurement shown below.",
    );
  }
  if (ceilingChanges.length > 0) {
    notices.push(
      `> ⚠️ **This PR changes transfer ceilings:**\n>\n${ceilingChanges.map((line) => `> ${line}`).join("\n")}`,
    );
  }

  return [
    COMMENT_MARKER,
    resultShaMarker(input.currentRun.sha),
    "## Thread transfer impact",
    "",
    failed
      ? "❌ One or more thread transfer ceilings were exceeded."
      : "✅ Thread transfer remains within every enforced ceiling.",
    ...(notices.length > 0 ? ["", ...notices] : []),
    "",
    "| Provider | Metric | Main baseline | This PR | Impact | PR ceiling | |",
    "| --- | --- | ---: | ---: | ---: | ---: | --- |",
    ...rows,
    "",
    `Baseline: ${baselineLink} · PR result: ${currentLink} · Source CI: ${input.currentRun.conclusion}`,
    "",
    "<details>",
    "<summary>Scenario and decoded snapshot size</summary>",
    "",
    `${current.scenario.historyTurns} historical turns, ${current.scenario.historyCommandToolsPerTurn} command tools per turn, ${formatBytes(current.scenario.historyMcpResultBytes)} retained MCP result per historical turn, and a ${formatBytes(current.scenario.measuredMcpResultBytes)} retained result in the measured turn.`,
    "",
    ...PROVIDERS.map(
      (provider) =>
        `- ${provider === "codex" ? "Codex" : "Claude"} decoded thread snapshot: ${formatBytes(current.providers[provider].observed.threadSnapshotDecodedBytes)}`,
    ),
    "",
    "</details>",
    "",
    "_Updated in place by a trusted workflow. PR artifacts are strictly validated and never executed._",
  ].join("\n");
}

async function artifactsForRun(github, owner, repo, runId) {
  return github.paginate(github.rest.actions.listWorkflowRunArtifacts, {
    owner,
    repo,
    run_id: runId,
    per_page: 100,
  });
}

function findResultArtifact(artifacts) {
  return artifacts.find((artifact) => artifact.name === ARTIFACT_NAME && !artifact.expired);
}

async function resolve({ github, context, core }) {
  const source = context.payload.workflow_run;
  const { owner, repo } = context.repo;
  if (source.event !== "pull_request") {
    core.setOutput("publish", "false");
    return;
  }

  let pullNumber = source.pull_requests?.[0]?.number;
  if (!pullNumber) {
    const associated = await github.paginate(
      github.rest.repos.listPullRequestsAssociatedWithCommit,
      { owner, repo, commit_sha: source.head_sha, per_page: 100 },
    );
    const matchingPulls = associated.filter(
      (pull) =>
        pull.state === "open" &&
        pull.head.sha === source.head_sha &&
        pull.head.ref === source.head_branch,
    );
    if (matchingPulls.length !== 1) {
      core.info(
        `Expected one open pull request for ${source.head_repository?.full_name ?? "unknown repository"}:${source.head_branch ?? "unknown branch"} at ${source.head_sha}; found ${matchingPulls.length}.`,
      );
      core.setOutput("publish", "false");
      return;
    }
    pullNumber = matchingPulls[0].number;
  }
  if (!pullNumber) {
    core.info("No open pull request is associated with the completed CI run.");
    core.setOutput("publish", "false");
    return;
  }

  const { data: pull } = await github.rest.pulls.get({ owner, repo, pull_number: pullNumber });
  if (pull.head.sha !== source.head_sha) {
    core.info(`Skipping stale CI result ${source.head_sha}; PR head is ${pull.head.sha}.`);
    core.setOutput("publish", "false");
    return;
  }

  const sourceArtifacts = await artifactsForRun(github, owner, repo, source.id);
  const sourceArtifact = findResultArtifact(sourceArtifacts);
  const workflowRuns = await github.paginate(github.rest.actions.listWorkflowRuns, {
    owner,
    repo,
    workflow_id: source.workflow_id,
    branch: pull.base.ref,
    event: "push",
    status: "success",
    per_page: 100,
  });
  const orderedRuns = [
    ...workflowRuns.filter((run) => run.head_sha === pull.base.sha),
    ...workflowRuns.filter((run) => run.head_sha !== pull.base.sha),
  ].slice(0, 20);

  let baselineRun;
  for (const run of orderedRuns) {
    const artifacts = await artifactsForRun(github, owner, repo, run.id);
    if (findResultArtifact(artifacts)) {
      baselineRun = run;
      break;
    }
  }

  core.setOutput("publish", "true");
  core.setOutput("pull_number", String(pullNumber));
  core.setOutput("pr_artifact", sourceArtifact ? "true" : "false");
  core.setOutput("pr_run_id", String(source.id));
  core.setOutput("pr_sha", source.head_sha);
  core.setOutput("pr_conclusion", source.conclusion ?? "unknown");
  core.setOutput("baseline_artifact", baselineRun ? "true" : "false");
  core.setOutput("baseline_run_id", baselineRun ? String(baselineRun.id) : "");
  core.setOutput("baseline_sha", baselineRun?.head_sha ?? "");
  core.setOutput(
    "baseline_matches_base",
    baselineRun?.head_sha === pull.base.sha ? "true" : "false",
  );
}

async function upsertComment(github, context, pullNumber, body, options = {}) {
  const { owner, repo } = context.repo;
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: pullNumber,
    per_page: 100,
  });
  const existing = comments.find(
    (comment) =>
      comment.user?.login === "github-actions[bot]" && comment.body?.includes(COMMENT_MARKER),
  );
  if (
    options.preserveResultSha &&
    existing?.body?.includes(resultShaMarker(options.preserveResultSha))
  ) {
    return;
  }
  if (existing) {
    await github.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
  } else {
    await github.rest.issues.createComment({ owner, repo, issue_number: pullNumber, body });
  }
}

async function upsertCommentForCurrentHead(
  github,
  context,
  core,
  pullNumber,
  expectedSha,
  body,
  options,
) {
  const { owner, repo } = context.repo;
  const { data: pull } = await github.rest.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
  });
  if (pull.head.sha !== expectedSha) {
    core.info(`Skipping stale CI result ${expectedSha}; PR head is ${pull.head.sha}.`);
    return false;
  }

  await upsertComment(github, context, pullNumber, body, options);
  return true;
}

async function publish({ github, context, core }) {
  const pullNumber = Number(process.env.PR_NUMBER);
  if (!Number.isSafeInteger(pullNumber) || pullNumber <= 0) {
    throw new Error("PR_NUMBER is invalid");
  }

  const current = readResult(process.env.PR_RESULT_DIR);
  const currentRun = {
    sha: process.env.PR_SHA,
    conclusion: process.env.PR_CONCLUSION,
    url: `https://github.com/${context.repo.owner}/${context.repo.repo}/actions/runs/${process.env.PR_RUN_ID}`,
  };
  if (!current) {
    await upsertCommentForCurrentHead(
      github,
      context,
      core,
      pullNumber,
      currentRun.sha,
      [
        COMMENT_MARKER,
        "## Thread transfer impact",
        "",
        `⚠️ The latest [CI run](${currentRun.url}) did not produce a thread transfer result for \`${currentRun.sha.slice(0, 7)}\`.`,
        "",
        "_This comment will update automatically after the next completed run._",
      ].join("\n"),
      { preserveResultSha: currentRun.sha },
    );
    return;
  }

  const baseline = readResult(process.env.BASELINE_RESULT_DIR);
  const baselineRun = baseline
    ? {
        sha: process.env.BASELINE_SHA,
        matchesBase: process.env.BASELINE_MATCHES_BASE === "true",
        url: `https://github.com/${context.repo.owner}/${context.repo.repo}/actions/runs/${process.env.BASELINE_RUN_ID}`,
      }
    : undefined;
  const body = renderComment({ current, baseline, currentRun, baselineRun });
  const published = await upsertCommentForCurrentHead(
    github,
    context,
    core,
    pullNumber,
    currentRun.sha,
    body,
  );
  if (published) {
    core.info(`Updated thread transfer report on PR #${pullNumber}.`);
  }
}

module.exports = {
  publish,
  readResult,
  renderComment,
  resolve,
  upsertCommentForCurrentHead,
  validateResult,
};
