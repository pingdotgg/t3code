const assert = require("node:assert/strict");
const test = require("node:test");

const {
  renderComment,
  resolve,
  upsertCommentForCurrentHead,
  validateResult,
} = require("./thread-transfer-report.cjs");

function result(overrides = {}) {
  const observed = {
    totalWireBytes: 2_200_000,
    threadSnapshotWireBytes: 1_950_000,
    threadSnapshotDecodedBytes: 9_100_000,
    measuredTurnWebSocketWireBytes: 250_000,
    measuredTurnWebSocketDecodedBytes: 1_150_000,
    measuredTurnWebSocketMessages: 15,
  };
  const ceiling = {
    totalWireBytes: 2_900_000,
    threadSnapshotWireBytes: 2_600_000,
    measuredTurnWebSocketWireBytes: 320_000,
    measuredTurnWebSocketDecodedBytes: 1_550_000,
    measuredTurnWebSocketMessages: 20,
  };
  return {
    schemaVersion: 1,
    scenario: {
      id: "thread-transfer-v1",
      historyTurns: 10,
      historyCommandToolsPerTurn: 5,
      historyMcpResultBytes: 900_000,
      measuredCommandTools: 20,
      measuredMcpResultBytes: 1_100_000,
    },
    providers: {
      codex: { observed: { ...observed, ...overrides }, ceiling },
      claudeAgent: { observed, ceiling },
    },
  };
}

test("validates the fixed artifact schema", () => {
  assert.equal(validateResult(result()).schemaVersion, 1);
  assert.throws(
    () => validateResult({ ...result(), injectedMarkdown: "@everyone" }),
    /unexpected fields/,
  );
  assert.throws(
    () => validateResult(result({ totalWireBytes: "lots" })),
    /non-negative safe integer/,
  );
});

test("renders baseline, impact, ceiling, and ceiling changes", () => {
  const baseline = result();
  const current = result({ measuredTurnWebSocketWireBytes: 260_000 });
  current.providers.codex.ceiling = {
    ...current.providers.codex.ceiling,
    measuredTurnWebSocketWireBytes: 330_000,
  };
  const comment = renderComment({
    current,
    baseline,
    currentRun: {
      sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      conclusion: "success",
      url: "https://github.com/pingdotgg/t3code/actions/runs/2",
    },
    baselineRun: {
      sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      matchesBase: true,
      url: "https://github.com/pingdotgg/t3code/actions/runs/1",
    },
  });

  assert.match(comment, /Main baseline \| This PR \| Impact \| PR ceiling/);
  assert.match(comment, /\+9\.8 KiB \(\+4\.0%\)/);
  assert.match(comment, /This PR changes transfer ceilings/);
  assert.match(comment, /312\.5 KiB → 322\.3 KiB/);
  assert.match(comment, /<!-- t3-thread-transfer-report -->/);
  assert.match(
    comment,
    /<!-- t3-thread-transfer-result-sha:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb -->/,
  );
});

test("resolves a fallback PR with a redacted head repo and exact main baseline", async () => {
  const outputs = {};
  const listWorkflowRunArtifacts = () => {};
  const listWorkflowRuns = () => {};
  const listPullRequestsAssociatedWithCommit = () => {};
  const github = {
    paginate: async (method, input) => {
      if (method === listPullRequestsAssociatedWithCommit) {
        return [
          {
            number: 5350,
            state: "open",
            head: { sha: "head-sha", ref: "feature-branch", repo: null },
          },
        ];
      }
      if (method === listWorkflowRunArtifacts) {
        return [
          {
            name: "thread-transfer-results",
            expired: false,
            runId: input.run_id,
          },
        ];
      }
      if (method === listWorkflowRuns) {
        return [{ id: 1, head_sha: "base-sha" }];
      }
      throw new Error("unexpected pagination call");
    },
    rest: {
      actions: { listWorkflowRunArtifacts, listWorkflowRuns },
      pulls: {
        get: async () => ({
          data: {
            head: { sha: "head-sha" },
            base: { sha: "base-sha", ref: "main" },
          },
        }),
      },
      repos: { listPullRequestsAssociatedWithCommit },
    },
  };
  await resolve({
    github,
    context: {
      repo: { owner: "pingdotgg", repo: "t3code" },
      payload: {
        workflow_run: {
          id: 2,
          event: "pull_request",
          workflow_id: 3,
          head_sha: "head-sha",
          head_branch: "feature-branch",
          head_repository: { full_name: "pingdotgg/t3code" },
          conclusion: "success",
          pull_requests: [],
        },
      },
    },
    core: {
      info: () => {},
      setOutput: (key, value) => {
        outputs[key] = value;
      },
    },
  });

  assert.equal(outputs.publish, "true");
  assert.equal(outputs.pull_number, "5350");
  assert.equal(outputs.pr_artifact, "true");
  assert.equal(outputs.baseline_run_id, "1");
  assert.equal(outputs.baseline_matches_base, "true");
});

test("does not guess when a fallback commit belongs to multiple PRs", async () => {
  const outputs = {};
  const listPullRequestsAssociatedWithCommit = () => {};
  let fetchedPull = false;
  await resolve({
    github: {
      paginate: async (method) => {
        assert.equal(method, listPullRequestsAssociatedWithCommit);
        return [5350, 5351].map((number) => ({
          number,
          state: "open",
          head: {
            sha: "head-sha",
            ref: "feature-branch",
            repo: { full_name: "pingdotgg/t3code" },
          },
        }));
      },
      rest: {
        actions: {},
        pulls: {
          get: async () => {
            fetchedPull = true;
          },
        },
        repos: { listPullRequestsAssociatedWithCommit },
      },
    },
    context: {
      repo: { owner: "pingdotgg", repo: "t3code" },
      payload: {
        workflow_run: {
          id: 2,
          event: "pull_request",
          workflow_id: 3,
          head_sha: "head-sha",
          head_branch: "feature-branch",
          head_repository: { full_name: "pingdotgg/t3code" },
          conclusion: "success",
          pull_requests: [],
        },
      },
    },
    core: {
      info: () => {},
      setOutput: (key, value) => {
        outputs[key] = value;
      },
    },
  });

  assert.equal(outputs.publish, "false");
  assert.equal(fetchedPull, false);
});

test("does not publish a stale result after the PR head advances", async () => {
  let listedComments = false;
  const info = [];
  const published = await upsertCommentForCurrentHead(
    {
      paginate: async () => {
        listedComments = true;
        return [];
      },
      rest: {
        issues: {
          listComments: () => {},
          createComment: () => {
            throw new Error("must not create a stale comment");
          },
          updateComment: () => {
            throw new Error("must not update a stale comment");
          },
        },
        pulls: {
          get: async () => ({ data: { head: { sha: "new-head-sha" } } }),
        },
      },
    },
    { repo: { owner: "pingdotgg", repo: "t3code" } },
    { info: (message) => info.push(message) },
    5350,
    "old-head-sha",
    "stale body",
  );

  assert.equal(published, false);
  assert.equal(listedComments, false);
  assert.deepEqual(info, ["Skipping stale CI result old-head-sha; PR head is new-head-sha."]);
});

test("preserves a successful result when a same-SHA rerun has no artifact", async () => {
  let updatedComment = false;
  const sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const published = await upsertCommentForCurrentHead(
    {
      paginate: async () => [
        {
          id: 1,
          user: { login: "github-actions[bot]" },
          body: `<!-- t3-thread-transfer-report -->\n<!-- t3-thread-transfer-result-sha:${sha} -->`,
        },
      ],
      rest: {
        issues: {
          listComments: () => {},
          createComment: () => {
            updatedComment = true;
          },
          updateComment: () => {
            updatedComment = true;
          },
        },
        pulls: {
          get: async () => ({ data: { head: { sha } } }),
        },
      },
    },
    { repo: { owner: "pingdotgg", repo: "t3code" } },
    { info: () => {} },
    5350,
    sha,
    "missing artifact warning",
    { preserveResultSha: sha },
  );

  assert.equal(published, true);
  assert.equal(updatedComment, false);
});
