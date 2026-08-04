const assert = require("node:assert/strict");
const test = require("node:test");

const { renderComment, resolve, validateResult } = require("./thread-transfer-report.cjs");

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
});

test("resolves the current PR artifact and exact main baseline", async () => {
  const outputs = {};
  const listWorkflowRunArtifacts = () => {};
  const listWorkflowRuns = () => {};
  const github = {
    paginate: async (method, input) => {
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
      repos: { listPullRequestsAssociatedWithCommit: () => {} },
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
          conclusion: "success",
          pull_requests: [{ number: 5350 }],
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
