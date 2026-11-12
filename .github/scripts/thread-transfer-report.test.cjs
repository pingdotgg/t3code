const assert = require("node:assert/strict");
const test = require("node:test");

const {
  renderComment,
  resolve,
  upsertCommentForCurrentHead,
  validateResult,
  validateScenarios,
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

function scenarios(overrides = {}) {
  const rows = [
    {
      phase: "long turn finished, cold open",
      metric: "HTTP decoded",
      unit: "bytes",
      observed: 390_000,
      ceiling: 420_000,
    },
    {
      phase: "idle thread resume",
      metric: "WebSocket messages",
      unit: "count",
      observed: 1,
      ceiling: 1,
    },
  ];
  return {
    schemaVersion: 1,
    providers: { codex: [{ ...rows[0], ...overrides }, rows[1]], claudeAgent: rows },
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

  assert.equal(validateScenarios(scenarios()).schemaVersion, 1);
  for (const phase of ["@everyone", "[link](https://example.com)", "a | b", "<img>", ""]) {
    assert.throws(() => validateScenarios(scenarios({ phase })), /short plain label/);
  }
  assert.throws(() => validateScenarios(scenarios({ note: "extra" })), /unexpected fields/);
  assert.throws(() => validateScenarios(scenarios({ ceiling: null })), /non-negative safe integer/);
  assert.throws(
    () =>
      validateScenarios(scenarios({ phase: "idle thread resume", metric: "WebSocket messages" })),
    /repeats an earlier row/,
  );
});

test("lists scenario rows that changed or failed above the collapsed table", () => {
  const run = { sha: "abcdef1234", url: "https://example.com/run", conclusion: "success" };
  const render = (currentScenarios, baselineScenarios) =>
    renderComment({
      current: result(),
      baseline: result(),
      currentScenarios,
      baselineScenarios,
      currentRun: run,
      baselineRun: { ...run, matchesBase: true },
    });
  const open = (body) => body.slice(0, body.indexOf("<details>"));

  const unchanged = render(scenarios(), scenarios());
  assert.match(unchanged, /✅ Thread transfer remains within every enforced ceiling/);
  assert.match(open(unchanged), /All 4 scenario measurements match `main`/);
  assert.doesNotMatch(open(unchanged), /long turn finished, cold open/);

  const grown = render(scenarios({ observed: 400_000 }), scenarios());
  assert.match(open(grown), /1 of 4 scenario measurements changed or failed/);
  assert.match(
    open(grown),
    /\| Codex \| `long turn finished, cold open` \| `HTTP decoded` \| 380\.9 KiB \| 390\.6 KiB \| \+9\.8 KiB \(\+2\.6%\) \| 410\.2 KiB \| ✅ \|/,
  );

  const over = render(scenarios({ observed: 430_000, ceiling: 425_000 }), scenarios());
  assert.match(over, /❌ One or more thread transfer ceilings were exceeded/);
  assert.match(
    over,
    /Codex `long turn finished, cold open` `HTTP decoded`: 410\.2 KiB → 415\.0 KiB/,
  );

  // A row `main` does not have is not reported as matching it.
  const added = render(scenarios({ phase: "GH-26" }), scenarios());
  assert.match(open(added), /3 scenario measurements match `main`\. 1 have no `main` baseline\./);
  assert.match(added, /\| Codex \| `GH-26` \|/);

  // A main run from before the scenario file has nothing to compare; a PR run from before it has no section.
  assert.match(open(render(scenarios(), undefined)), /No `main` baseline exists yet/);
  assert.doesNotMatch(render(undefined, scenarios()), /Other scenarios/);
});

test("resolves a fallback PR with a redacted head repo and exact main baseline", async () => {
  const outputs = {};
  const listWorkflowRunArtifacts = () => {};
  // The exact base run sits far past the newest page of main CI runs.
  const mainRuns = Array.from({ length: 1_000 }, (_, index) => ({
    id: 1_000 - index,
    head_sha: index === 900 ? "base-sha" : `main-sha-${index}`,
  }));
  const listWorkflowRuns = async ({ head_sha, per_page }) => ({
    data: {
      workflow_runs: mainRuns
        .filter((run) => head_sha === undefined || run.head_sha === head_sha)
        .slice(0, per_page),
    },
  });
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
  assert.equal(outputs.baseline_run_id, "100");
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

test("skips a missing PR commit but preserves other lookup failures", async () => {
  for (const [status, message, shouldSkip] of [
    [422, "No commit found for SHA: old-head", true],
    [422, "Validation Failed", false],
    [403, "API rate limit exceeded", false],
  ]) {
    const outputs = {};
    const error = Object.assign(new Error(message), {
      status,
      response: { data: { message } },
    });
    const run = resolve({
      github: {
        paginate: async () => {
          throw error;
        },
        rest: { repos: { listPullRequestsAssociatedWithCommit: () => {} } },
      },
      context: {
        repo: { owner: "pingdotgg", repo: "t3code" },
        payload: {
          workflow_run: { event: "pull_request", head_sha: "old-head", pull_requests: [] },
        },
      },
      core: {
        info: () => {},
        setOutput: (key, value) => {
          outputs[key] = value;
        },
      },
    });
    if (shouldSkip) {
      await run;
      assert.equal(outputs.publish, "false");
    } else {
      await assert.rejects(run, (caught) => caught === error);
      assert.deepEqual(outputs, {});
    }
  }
});

test("does not report a passing run that skipped the server tests", async () => {
  const outputs = {};
  const listWorkflowRunArtifacts = () => {};
  await resolve({
    github: {
      paginate: async (method) => {
        assert.equal(method, listWorkflowRunArtifacts);
        return [];
      },
      rest: {
        actions: { listWorkflowRunArtifacts },
        pulls: {
          get: async () => ({
            data: { head: { sha: "head-sha" }, base: { sha: "base-sha", ref: "main" } },
          }),
        },
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

  assert.equal(outputs.publish, "false");
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
