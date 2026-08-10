// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Tests build real temporary Git repositories and inject a fixed wall-clock date.
import { assert, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { inspectBaseline, parseNameStatus } from "./check-t3-baseline.ts";

function git(root: string, ...args: ReadonlyArray<string>): string {
  return NodeChildProcess.execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
  }).trim();
}

function write(root: string, path: string, contents: string): void {
  const target = NodePath.join(root, path);
  NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
  NodeFS.writeFileSync(target, contents);
}

function commitAll(root: string, message: string): string {
  git(root, "add", "--all");
  git(root, "commit", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

function baselineConfiguration(
  commit: string,
  permanentGovernanceFiles: ReadonlyArray<{
    readonly path: string;
    readonly owner: string;
    readonly reason: string;
    readonly contentSha256: string;
    readonly test: string;
  }> = [],
): string {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      upstream: {
        repository: "https://github.com/pingdotgg/t3code.git",
        remote: "upstream",
        branch: "main",
        commit,
      },
      selection: {
        selectedOn: "2026-08-10",
        previousForkCommit: commit,
        before: { ahead: 0, behind: 0 },
        after: { ahead: 0, behind: 0 },
        upstreamChangedPaths: [],
      },
      classification: {
        additiveMarketingRoots: ["apps/auldric-marketing/"],
        distributionConfigurationPaths: [
          ".auldric/shared-core-allowlist.json",
          ".auldric/t3-baseline.json",
        ],
        permanentGovernanceFiles,
        sharedCoreAllowlist: ".auldric/shared-core-allowlist.json",
      },
    },
    null,
    2,
  )}\n`;
}

function sha256(value: string): string {
  return NodeCrypto.createHash("sha256").update(value).digest("hex");
}

function createRepository(): { readonly root: string; readonly baseline: string } {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "auldric-baseline-"));
  git(root, "init", "--initial-branch=main");
  git(root, "config", "user.email", "baseline-test@example.com");
  git(root, "config", "user.name", "Baseline Test");
  write(root, "apps/web/core.txt", "t3 v1\n");
  const baseline = commitAll(root, "upstream baseline");
  git(root, "update-ref", "refs/remotes/upstream/main", baseline);
  return { root, baseline };
}

function writeGovernance(root: string, baseline: string): void {
  write(root, ".auldric/t3-baseline.json", baselineConfiguration(baseline));
  write(
    root,
    ".auldric/shared-core-allowlist.json",
    `${JSON.stringify({ schemaVersion: 1, entries: [] }, null, 2)}\n`,
  );
}

function writeAllowlist(root: string, expiresOn: string): void {
  write(
    root,
    ".auldric/shared-core-allowlist.json",
    `${JSON.stringify(
      {
        schemaVersion: 1,
        entries: [
          {
            path: "apps/web/core.txt",
            owner: "@maintainer",
            reason: "Temporary boundary needed by the fixture",
            expiresOn,
            upstream: {
              status: "proposed",
              url: "https://github.com/pingdotgg/t3code/issues/123",
            },
            test: "pnpm run test -- core.test.ts",
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
}

function inspect(root: string) {
  return inspectBaseline({
    repoRoot: root,
    verifyRemote: false,
    now: new Date("2026-08-10T12:00:00Z"),
  });
}

it("parses ordinary and renamed Git paths without losing either side", () => {
  assert.deepEqual(parseNameStatus("A\0new.txt\0R100\0old.txt\0moved.txt\0"), [
    { status: "A", paths: ["new.txt"] },
    { status: "R100", paths: ["old.txt", "moved.txt"] },
  ]);
});

it("allows only distribution configuration and additive Marketing code", () => {
  const { root, baseline } = createRepository();
  try {
    writeGovernance(root, baseline);
    write(root, "apps/auldric-marketing/workflow.txt", "marketing only\n");
    commitAll(root, "add isolated marketing workflow");

    const report = inspect(root);

    assert.equal(report.ok, true);
    assert.equal(report.ancestry.baselineInRelease, true);
    assert.equal(report.commitDrift.baselineToRelease.ahead, 1);
    assert.deepEqual(
      new Set(report.fileDrift.map((entry) => entry.category)),
      new Set(["additive-marketing", "distribution-configuration"]),
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("fails an unexpected edit to T3-owned code", () => {
  const { root, baseline } = createRepository();
  try {
    writeGovernance(root, baseline);
    write(root, "apps/web/core.txt", "downstream platform behavior\n");
    commitAll(root, "change t3 core");

    const report = inspect(root);

    assert.equal(report.ok, false);
    assert.deepEqual(report.violations, ["unexpected shared-core edit: apps/web/core.txt"]);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("accepts only the reviewed content of a permanent governance file", () => {
  const { root, baseline } = createRepository();
  try {
    const reviewedContent = "T3 owns Dev; Auldric owns Marketing.\n";
    write(
      root,
      ".auldric/t3-baseline.json",
      baselineConfiguration(baseline, [
        {
          path: "apps/web/core.txt",
          owner: "#17",
          reason: "Fixture authority statement",
          contentSha256: sha256(reviewedContent),
          test: "pnpm run complete:feature-docs",
        },
      ]),
    );
    write(
      root,
      ".auldric/shared-core-allowlist.json",
      `${JSON.stringify({ schemaVersion: 1, entries: [] }, null, 2)}\n`,
    );
    write(root, "apps/web/core.txt", reviewedContent);
    commitAll(root, "record reviewed governance");

    const accepted = inspect(root);
    assert.equal(accepted.ok, true);
    assert.equal(
      accepted.fileDrift.find((entry) => entry.paths.includes("apps/web/core.txt"))?.category,
      "downstream-governance",
    );

    write(root, "apps/web/core.txt", "unreviewed extra behavior\n");
    commitAll(root, "change reviewed governance unexpectedly");
    const rejected = inspect(root);
    assert.equal(rejected.ok, false);
    assert.include(rejected.violations, "unexpected shared-core edit: apps/web/core.txt");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("accepts a complete, unexpired exact-path shared-core seam", () => {
  const { root, baseline } = createRepository();
  try {
    writeGovernance(root, baseline);
    writeAllowlist(root, "2026-08-11");
    write(root, "apps/web/core.txt", "small temporary seam\n");
    commitAll(root, "add temporary shared seam");

    const report = inspect(root);

    assert.equal(report.ok, true);
    assert.equal(
      report.fileDrift.find((entry) => entry.paths.includes("apps/web/core.txt"))?.category,
      "temporary-shared-core-seam",
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("rejects an expired shared-core seam", () => {
  const { root, baseline } = createRepository();
  try {
    writeGovernance(root, baseline);
    writeAllowlist(root, "2026-08-09");
    write(root, "apps/web/core.txt", "expired seam\n");
    commitAll(root, "add expired shared seam");

    assert.throws(() => inspect(root), /expired on 2026-08-09/);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("replays isolated Marketing work onto a later T3 commit without retaining old core", () => {
  const { root, baseline } = createRepository();
  try {
    writeGovernance(root, baseline);
    write(root, "apps/auldric-marketing/workflow.txt", "marketing only\n");
    const downstream = commitAll(root, "add isolated marketing workflow");

    git(root, "switch", "--create", "upstream-next", baseline);
    write(root, "apps/web/core.txt", "t3 v2\n");
    const nextBaseline = commitAll(root, "upstream updates core");

    git(root, "switch", "--create", "release-next", nextBaseline);
    git(root, "cherry-pick", downstream);
    write(root, ".auldric/t3-baseline.json", baselineConfiguration(nextBaseline));
    commitAll(root, "record later upstream baseline");
    git(root, "update-ref", "refs/remotes/upstream/main", nextBaseline);

    const report = inspect(root);

    assert.equal(report.ok, true);
    assert.equal(report.baseline, nextBaseline);
    assert.equal(report.ancestry.baselineInRelease, true);
    assert.equal(NodeFS.readFileSync(NodePath.join(root, "apps/web/core.txt"), "utf8"), "t3 v2\n");
    assert.equal(
      report.fileDrift.some((entry) => entry.paths.includes("apps/web/core.txt")),
      false,
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
