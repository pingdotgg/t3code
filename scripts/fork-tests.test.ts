import { assert, describe, it } from "@effect/vitest";

import {
  aggregateExitCode,
  fullProcessPlan,
  fullSuiteEnvironment,
  readKnownFailures,
  skipPattern,
} from "./fork-tests.ts";

describe("fullProcessPlan", () => {
  it("runs four distinct server shards and one process per other project", () => {
    const projects = ["root", "t3", "@t3tools/web (browser) (chromium)"];
    const filter = ["-t", "pattern"];
    const plan = fullProcessPlan(projects, filter, 9);
    assert.deepEqual(
      plan.map(({ args }) => args),
      [
        ["--project=t3", "--shard=1/4", "--no-cache", ...filter],
        ["--project=t3", "--shard=2/4", "--no-cache", ...filter],
        ["--project=t3", "--shard=3/4", "--no-cache", ...filter],
        ["--project=t3", "--shard=4/4", "--no-cache", ...filter],
        ["--project=root", "--maxWorkers=3", ...filter],
        ["--project=@t3tools/web (browser) (chromium)", "--maxWorkers=2", ...filter],
      ],
    );
    assert.equal(new Set(plan.map(({ name }) => name)).size, plan.length);
  });

  it("uses the default shard count and respects machines with fewer cores", () => {
    assert.lengthOf(fullProcessPlan(["t3"], []), 4);
    assert.deepEqual(
      fullProcessPlan(["t3", "root"], [], 1).map(({ args }) => args),
      [
        ["--project=t3", "--shard=1/1", "--no-cache"],
        ["--project=root", "--maxWorkers=1"],
      ],
    );
  });

  it("fails instead of silently omitting the server suite", () => {
    assert.throws(() => fullProcessPlan(["root"], []), "server project");
  });
});

describe("fullSuiteEnvironment", () => {
  it("removes ambient GitHub credentials without changing the parent environment", () => {
    const token = "fixture-token";
    const inherited = {
      PATH: "fixture-path",
      GH_TOKEN: token,
      GITHUB_TOKEN: token,
      GH_ENTERPRISE_TOKEN: token,
      GITHUB_ENTERPRISE_TOKEN: token,
    };
    assert.deepEqual(fullSuiteEnvironment(inherited), { PATH: "fixture-path" });
    assert.equal(inherited.GITHUB_TOKEN, token);
  });
});

describe("aggregateExitCode", () => {
  it("succeeds when all processes exit cleanly", () => {
    assert.equal(aggregateExitCode([0, 0]), 0);
  });

  it("keeps the first nonzero process status in plan order", () => {
    assert.equal(aggregateExitCode([0, 9, 0, 1]), 9);
  });
});

describe("skipPattern", () => {
  it("matches every test name except the known failures", () => {
    const pattern = new RegExp(
      skipPattern([{ file: "a.test.ts", test: "reads (a) file.", reason: "macOS" }]),
    );
    assert.isFalse(pattern.test("suite reads (a) file."));
    assert.isTrue(pattern.test("suite reads a file"));
  });
});

describe("readKnownFailures", () => {
  it("rejects an entry without a reason", () => {
    assert.throws(() => readKnownFailures('[{"file":"a.test.ts","test":"x"}]'));
  });
});
