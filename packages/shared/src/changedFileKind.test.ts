import { describe, expect, it } from "vite-plus/test";

import { classifyChangedFile } from "./changedFileKind.ts";

describe("classifyChangedFile", () => {
  it.each([
    ["apps/server/src/ws.ts", "code"],
    ["src/latest.ts", "code"],
    ["src/Latest.java", "code"],
    ["src/contest.py", "code"],
    ["src/mockingbird.ts", "code"],
    ["src/testimonials/List.tsx", "code"],
    ["apps/web/src/foo.test.ts", "tests"],
    ["apps/web/src/Foo.browser.test.tsx", "tests"],
    ["src/foo.spec.js", "tests"],
    ["pkg/server_test.go", "tests"],
    ["tests/test_api.py", "tests"],
    ["conftest.py", "tests"],
    ["src/main/java/RequestTest.java", "tests"],
    ["Sources/AppTests.swift", "tests"],
    ["src/HTTPTest.java", "tests"],
    ["Sources/URLTests.swift", "tests"],
    ["spec/models/user_spec.rb", "tests"],
    ["src/__tests__/helpers.ts", "tests"],
    ["src/testUtils.ts", "code"],
    ["src\\__tests__\\app.ts", "tests"],
    ["src/__mocks__/fs.ts", "mocks"],
    ["test/fixtures/pr.json", "mocks"],
    ["src/__snapshots__/view.test.ts.snap", "mocks"],
    ["src/api.mock.ts", "mocks"],
    ["src/mockServer.ts", "mocks"],
    ["pkg/testdata/input.txt", "mocks"],
    ["pnpm-lock.yaml", "generated"],
    ["apps/web/package-lock.json", "generated"],
    ["go.sum", "generated"],
    ["src/routeTree.gen.ts", "generated"],
    ["src/__generated__/types.ts", "generated"],
    ["dist/app.min.js", "generated"],
    ["README.md", "docs"],
    ["docs/internals/overview.mdx", "docs"],
    ["NOTES.txt", "docs"],
    ["requirements-dev.txt", "code"],
    ["CMakeLists.txt", "code"],
    ["tests/README.md", "tests"],
  ] as const)("%s is %s", (path, kind) => {
    expect(classifyChangedFile(path)).toBe(kind);
  });
});
