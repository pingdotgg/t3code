const assert = require("node:assert/strict");
const test = require("node:test");
const { shouldReleaseNightly } = require("./check-nightly-release.cjs");

const now = Date.parse("2026-09-05T12:00:00Z");
const hour = 60 * 60 * 1000;
const nightly = (hoursAgo, overrides = {}) => ({
  tag_name: "v1.0.1-nightly.20260905.123",
  draft: false,
  published_at: new Date(now - hoursAgo * hour).toISOString(),
  ...overrides,
});

function fixture({ releases = [nightly(7)], releasedSha = "old", activeStatus } = {}) {
  const calls = [];
  return {
    calls,
    options: {
      now,
      context: { repo: { owner: "example", repo: "app" }, sha: "new" },
      core: { info() {} },
      github: {
        rest: {
          actions: {
            async listWorkflowRuns(params) {
              calls.push(params);
              return { data: { total_count: params.status === activeStatus ? 1 : 0 } };
            },
          },
          repos: {
            listReleases() {},
            async getCommit(params) {
              calls.push(params);
              return { data: { sha: releasedSha } };
            },
          },
        },
        async paginate() {
          return releases;
        },
      },
    },
  };
}

test("releases the first nightly when no nightly is published", async () => {
  const { options } = fixture({
    releases: [nightly(0, { tag_name: "v1.0.0" }), nightly(0, { draft: true })],
  });
  assert.equal(await shouldReleaseNightly(options), true);
});

test("waits six hours after publication, including manual nightlies", async () => {
  for (const age of [0, 3, 6 - 1 / 3600]) {
    const { options, calls } = fixture({ releases: [nightly(age)] });
    assert.equal(await shouldReleaseNightly(options), false);
    assert.equal(calls.length, 0);
  }
});

test("releases new commits at six hours and after an idle period", async () => {
  for (const age of [6, 7, 24]) {
    const { options } = fixture({ releases: [nightly(age)] });
    assert.equal(await shouldReleaseNightly(options), true);
  }
});

test("skips unchanged commits after the gap", async () => {
  const { options } = fixture({ releasedSha: "new" });
  assert.equal(await shouldReleaseNightly(options), false);
});

test("uses publication time, not release order or the tagged commit date", async () => {
  const { options } = fixture({
    releases: [nightly(10), nightly(1), nightly(20, { tag_name: "nightly-v0.9.0" })],
  });
  assert.equal(await shouldReleaseNightly(options), false);
});

test("ignores stable releases and drafts when checking the gap", async () => {
  const { options } = fixture({
    releases: [nightly(0, { tag_name: "v1.0.0" }), nightly(0, { draft: true }), nightly(7)],
  });
  assert.equal(await shouldReleaseNightly(options), true);
});

test("resolves the published tag to a commit, including legacy nightly tags", async () => {
  const tag = "nightly-v0.9.0";
  const { options, calls } = fixture({ releases: [nightly(7, { tag_name: tag })] });
  assert.equal(await shouldReleaseNightly(options), true);
  assert.equal(calls[0].ref, tag);
});

for (const status of ["in_progress", "queued", "waiting", "pending", "requested"]) {
  test(`skips dispatch when a release is ${status}`, async () => {
    const { options } = fixture({ activeStatus: status });
    options.github.paginate = async () => assert.fail("Must stop before checking releases");
    assert.equal(await shouldReleaseNightly({ ...options, checkActiveRuns: true }), false);
  });
}

test("dispatches when no release is active and new commits are due", async () => {
  const { options } = fixture();
  assert.equal(await shouldReleaseNightly({ ...options, checkActiveRuns: true }), true);
});

test("rechecks publication after a manual run finishes ahead of an automatic run", async () => {
  const { options } = fixture();
  assert.equal(await shouldReleaseNightly({ ...options, checkActiveRuns: true }), true);
  options.github.paginate = async () => [nightly(0)];
  assert.equal(await shouldReleaseNightly(options), false);
});

test("fails instead of dispatching when GitHub cannot supply release state", async () => {
  const { options } = fixture();
  options.github.paginate = async () => {
    throw new Error("GitHub unavailable");
  };
  await assert.rejects(shouldReleaseNightly(options), /GitHub unavailable/);
});
