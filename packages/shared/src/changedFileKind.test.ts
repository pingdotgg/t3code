import { describe, expect, it } from "vite-plus/test";

import { classifyChangedFile } from "./changedFileKind.ts";

describe("classifyChangedFile", () => {
  it.each([
    ["src/contest.py", "code"],
    ["test/fixtures/pr.json", "mocks"],
    ["src/__snapshots__/view.test.ts.snap", "mocks"],
    ["src/api.mock.ts", "mocks"],
    ["packages/riptech/stripe/testing/stripe.fixtures.ts", "mocks"],
    ["packages/riptech/data-table/src/components/data-table.fixtures.tsx", "mocks"],
    ["packages/artelo/open-api/testing/zod-issues.fixtures.ts", "mocks"],
    ["packages/riptech/test-utils/src/wait-until.fixtures.test.ts", "tests"],
    ["src/fixture.ts", "mocks"],
    ["src/fixture-user.ts", "mocks"],
    ["src/fixtures/user.json", "mocks"],
    ["src/__fixtures__/user.json", "mocks"],
    ["src/mock-procedures.ts", "mocks"],
    ["src/request.stub.ts", "mocks"],
    ["src/fakes/clock.ts", "mocks"],
    ["src/mockServer.ts", "mocks"],
    ["pkg/testdata/input.txt", "mocks"],
    ["pnpm-lock.yaml", "generated"],
    ["convex/_generated/api.d.ts", "generated"],
    ["src/agent.eval.ts", "tests"],
    ["evals/title-generation.ts", "tests"],
    ["README.md", "docs"],
    ["tests/README.md", "tests"],
  ] as const)("%s is %s", (path, kind) => {
    expect(classifyChangedFile(path)).toBe(kind);
  });
});
