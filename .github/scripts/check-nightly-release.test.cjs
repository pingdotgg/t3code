const assert = require("node:assert/strict");
const test = require("node:test");
const {
  assertCommitOnDefaultBranch,
  assertReleaseSource,
  shouldReleaseNightly,
} = require("./check-nightly-release.cjs");

const now = Date.parse("2026-09-05T12:00:00Z");
const hour = 60 * 60 * 1000;
const nightly = (hoursAgo, overrides = {}) => ({
  tagName: "v1.0.1-nightly.20260905.123",
  isDraft: false,
  publishedAt: new Date(now - hoursAgo * hour).toISOString(),
  ...overrides,
});
const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

function releaseSourceFixture({
  comparisonStatus = "ahead",
  eventName = "workflow_dispatch",
  ref = "refs/heads/main",
  sha = "candidate",
} = {}) {
  const calls = [];
  return {
    calls,
    options: {
      context: {
        eventName,
        payload: { repository: { default_branch: "main" } },
        ref,
        repo: { owner: "example", repo: "app" },
        sha,
      },
      github: {
        rest: {
          repos: {
            async compareCommitsWithBasehead(params) {
              calls.push(params);
              return { data: { status: comparisonStatus } };
            },
          },
        },
      },
    },
  };
}

test("allows preview releases from any branch without consulting main", async () => {
  const { options, calls } = releaseSourceFixture({ ref: "refs/heads/feature" });
  await assertReleaseSource({ ...options, releaseChannel: "preview" });
  assert.equal(calls.length, 0);
});

for (const releaseChannel of ["stable", "nightly"]) {
  test(`rejects a manual ${releaseChannel} release from a feature branch`, async () => {
    const { options, calls } = releaseSourceFixture({ ref: "refs/heads/feature" });
    await assert.rejects(
      assertReleaseSource({ ...options, releaseChannel }),
      new RegExp(`${releaseChannel} releases must be dispatched from main`),
    );
    assert.equal(calls.length, 0);
  });
}

for (const comparisonStatus of ["behind", "diverged"]) {
  test(`rejects a release commit that is ${comparisonStatus} from main`, async () => {
    const { options } = releaseSourceFixture({ comparisonStatus, eventName: "push" });
    await assert.rejects(
      assertCommitOnDefaultBranch({ ...options, sha: "release-commit" }),
      new RegExp(`not contained in main \\(${comparisonStatus}\\)`),
    );
  });
}

// `pages` holds the GraphQL release pages; `releases` is shorthand for one page.
// `failures` are thrown, in order, before the listed pages are served.
function fixture({
  releases = [nightly(7)],
  pages = [releases],
  failures = [],
  comparisonStatus = "ahead",
} = {}) {
  const calls = [];
  const cursors = [];
  const sleeps = [];
  return {
    calls,
    cursors,
    sleeps,
    options: {
      now,
      sleep: async (ms) => sleeps.push(ms),
      context: { repo: { owner: "example", repo: "app" }, sha: "new" },
      core: { info() {}, warning() {} },
      github: {
        rest: {
          repos: {
            async compareCommitsWithBasehead(params) {
              calls.push(params);
              return { data: { status: comparisonStatus } };
            },
          },
        },
        async graphql(_query, { owner, repo, cursor }) {
          assert.deepEqual({ owner, repo }, { owner: "example", repo: "app" });
          cursors.push(cursor);
          if (failures.length > 0) throw failures.shift();
          const index = cursor === null ? 0 : Number(cursor);
          const hasNextPage = index + 1 < pages.length;
          return {
            repository: {
              releases: {
                nodes: pages[index],
                pageInfo: { hasNextPage, endCursor: hasNextPage ? String(index + 1) : null },
              },
            },
          };
        },
      },
    },
  };
}

test("releases the first nightly when no nightly is published", async () => {
  const { options } = fixture({
    releases: [nightly(0, { tagName: "v1.0.0" }), nightly(0, { isDraft: true })],
  });
  assert.equal(await shouldReleaseNightly(options), true);
});

test("uses publication time, not release order or the tagged commit date", async () => {
  const { options } = fixture({
    releases: [nightly(10), nightly(1), nightly(20, { tagName: "nightly-v0.9.0" })],
  });
  assert.equal(await shouldReleaseNightly(options), false);
});

test("the six-hour gap ends exactly six hours after publication", async () => {
  const atBoundary = fixture({ releases: [nightly(6)] });
  assert.equal(await shouldReleaseNightly(atBoundary.options), true);
  const justInside = fixture({ releases: [nightly(6 - 1 / 3_600_000)] });
  assert.equal(await shouldReleaseNightly(justInside.options), false);
  assert.equal(justInside.calls.length, 0);
});

test("stops reading releases once a nightly inside the gap is seen", async () => {
  const { options, cursors } = fixture({ pages: [[nightly(10), nightly(2)], [nightly(30)]] });
  assert.equal(await shouldReleaseNightly(options), false);
  assert.deepEqual(cursors, [null]);
});

test("reads every page when no nightly seen so far settles the gap", async () => {
  const { options, cursors, calls } = fixture({
    pages: [
      [nightly(10), nightly(0, { tagName: "v1.0.0" })],
      [nightly(1, { tagName: "nightly-v0.9.0" })],
    ],
  });
  assert.equal(await shouldReleaseNightly(options), false);
  assert.deepEqual(cursors, [null, "1"]);
  assert.equal(calls.length, 0);
});

test("compares against the newest nightly across pages once the gap has passed", async () => {
  const { options, calls } = fixture({
    pages: [[nightly(10, { tagName: "v1.0.1-nightly.20260905.100" })], [nightly(8)]],
  });
  assert.equal(await shouldReleaseNightly(options), true);
  assert.deepEqual(
    calls.map((call) => call.basehead),
    ["v1.0.1-nightly.20260905.123...new"],
  );
});

test("ignores stable releases and drafts when checking the gap", async () => {
  const { options } = fixture({
    releases: [nightly(0, { tagName: "v1.0.0" }), nightly(0, { isDraft: true }), nightly(7)],
  });
  assert.equal(await shouldReleaseNightly(options), true);
});

test("retries transient release list failures with bounded backoff", async () => {
  const { options, sleeps } = fixture({ failures: [httpError(504), httpError(500)] });
  assert.equal(await shouldReleaseNightly(options), true);
  assert.deepEqual(sleeps, [2_000, 5_000]);
});

test("fails instead of releasing when transient failures outlast the retries", async () => {
  const failures = [500, 504, 502, 503].map(httpError);
  const { options, cursors, sleeps } = fixture({ failures });
  await assert.rejects(shouldReleaseNightly(options), /HTTP 503/);
  assert.equal(cursors.length, 4);
  assert.deepEqual(sleeps, [2_000, 5_000, 10_000]);
});

for (const failure of [httpError(401), httpError(422), new Error("GraphQL query error")]) {
  test(`fails at once without retrying: ${failure.message}`, async () => {
    const { options, cursors } = fixture({ failures: [failure] });
    await assert.rejects(shouldReleaseNightly(options), failure);
    assert.equal(cursors.length, 1);
  });
}

test("retries a transient failure on a later page without losing earlier pages", async () => {
  const { options, cursors, calls } = fixture({
    pages: [[nightly(10)], [nightly(8, { tagName: "v1.0.1-nightly.20260905.200" })]],
  });
  const graphql = options.github.graphql;
  let failed = false;
  options.github.graphql = async (query, variables) => {
    if (variables.cursor === "1" && !failed) {
      failed = true;
      cursors.push(variables.cursor);
      throw httpError(502);
    }
    return graphql(query, variables);
  };
  assert.equal(await shouldReleaseNightly(options), true);
  assert.deepEqual(cursors, [null, "1", "1"]);
  assert.deepEqual(
    calls.map((call) => call.basehead),
    ["v1.0.1-nightly.20260905.200...new"],
  );
});

test("retries a transient comparison failure", async () => {
  const { options, calls, sleeps } = fixture();
  const compare = options.github.rest.repos.compareCommitsWithBasehead;
  let failed = false;
  options.github.rest.repos.compareCommitsWithBasehead = async (params) => {
    if (!failed) {
      failed = true;
      throw httpError(500);
    }
    return compare(params);
  };
  assert.equal(await shouldReleaseNightly(options), true);
  assert.equal(calls.length, 1);
  assert.deepEqual(sleeps, [2_000]);
});

for (const status of ["behind", "diverged"]) {
  test(`skips a candidate commit that is ${status} relative to the last nightly`, async () => {
    const { options } = fixture({ comparisonStatus: status });
    assert.equal(await shouldReleaseNightly(options), false);
  });
}

const { resolveLatestNightlyCommit } = require("./check-nightly-release.cjs");

function nightlyCommitFixture({ releases, pages, commitSha = "abc123" }) {
  const refs = [];
  const { options } = fixture({ releases, pages });
  options.github.rest.repos.getCommit = async ({ ref }) => {
    refs.push(ref);
    return { data: { sha: commitSha } };
  };
  return { options, refs };
}

test("stable releases resolve the commit of the newest published nightly", async () => {
  const { options, refs } = nightlyCommitFixture({
    releases: [
      nightly(10, { tagName: "v1.0.1-nightly.20260905.100" }),
      nightly(1, { tagName: "v1.0.1-nightly.20260905.123" }),
      nightly(0, { tagName: "v1.0.0" }),
      nightly(0, { isDraft: true, tagName: "v1.0.1-nightly.20260905.999" }),
    ],
    commitSha: "deadbeef",
  });
  assert.deepEqual(await resolveLatestNightlyCommit(options), {
    tag: "v1.0.1-nightly.20260905.123",
    sha: "deadbeef",
    version: "1.0.1",
  });
  assert.deepEqual(refs, ["v1.0.1-nightly.20260905.123"]);
});

test("stable releases derive the version from legacy nightly tags", async () => {
  const { options } = nightlyCommitFixture({
    releases: [nightly(1, { tagName: "nightly-v0.9.0-nightly.20260905.5" })],
  });
  assert.equal((await resolveLatestNightlyCommit(options)).version, "0.9.0");
});

test("stable releases read every page, even after a recent nightly", async () => {
  const { options, refs } = nightlyCommitFixture({
    pages: [
      [nightly(2, { tagName: "v1.0.1-nightly.20260905.100" })],
      [nightly(1, { tagName: "v1.0.1-nightly.20260905.123" })],
    ],
  });
  assert.equal((await resolveLatestNightlyCommit(options)).tag, "v1.0.1-nightly.20260905.123");
  assert.deepEqual(refs, ["v1.0.1-nightly.20260905.123"]);
});

test("stable releases fail when no nightly is published", async () => {
  const { options } = nightlyCommitFixture({ releases: [nightly(1, { tagName: "v1.0.0" })] });
  await assert.rejects(resolveLatestNightlyCommit(options), /No published nightly found/);
});
