import type { RepositoryIdentity } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { buildGitHubFileLineUrl, fileLineNumberFromComposedPath } from "./fileGitHubLink";

const identity = (overrides: Partial<RepositoryIdentity> = {}): RepositoryIdentity => ({
  canonicalKey: "github.com/t3tools/t3code",
  locator: {
    source: "git-remote",
    remoteName: "origin",
    remoteUrl: "git@github.com:T3Tools/T3Code.git",
  },
  rootPath: "/repo",
  displayName: "t3tools/t3code",
  provider: "github",
  owner: "t3tools",
  name: "t3code",
  ...overrides,
});

class TestElement extends EventTarget {
  constructor(private readonly attributes: Record<string, string>) {
    super();
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }
}

const element = (attributes: Record<string, string>) => new TestElement(attributes);
const remoteRef = (refName: string, remoteName = "origin") => ({
  name: `${remoteName}/${refName}`,
  isRemote: true,
  remoteName,
});

beforeEach(() => vi.stubGlobal("Element", TestElement));
afterEach(() => vi.unstubAllGlobals());

describe("file GitHub line links", () => {
  it("finds source lines and gutter line numbers across a composed event path", () => {
    expect(fileLineNumberFromComposedPath([element({}), element({ "data-line": "42" })])).toBe(42);
    expect(
      fileLineNumberFromComposedPath([element({ "data-column-number": "17" }), element({})]),
    ).toBe(17);
  });

  it("ignores context-menu targets that are not valid source lines", () => {
    expect(
      fileLineNumberFromComposedPath([
        new EventTarget(),
        element({ "data-line-annotation": "1,2" }),
        element({ "data-line": "0" }),
        element({ "data-column-number": "12px" }),
      ]),
    ).toBeNull();
  });

  it("builds a link to the checked-out GitHub branch and line", () => {
    expect(
      buildGitHubFileLineUrl({
        identity: identity(),
        refName: "feature/github-links",
        relativePath: "apps/web/src/main.ts",
        workspaceRoot: "/repo",
        repositoryRoot: "/repo",
        remoteRefs: [remoteRef("feature/github-links")],
        line: 42,
      }),
    ).toBe("https://github.com/t3tools/t3code/blob/feature/github-links/apps/web/src/main.ts#L42");
  });

  it("includes a nested workspace path and escapes file names", () => {
    expect(
      buildGitHubFileLineUrl({
        identity: identity(),
        refName: "main",
        relativePath: "src/100% #ready.ts",
        workspaceRoot: "/repo/apps/web",
        repositoryRoot: "/repo",
        remoteRefs: [remoteRef("main")],
        line: 7,
      }),
    ).toBe("https://github.com/t3tools/t3code/blob/main/apps/web/src/100%25%20%23ready.ts#L7");
  });

  it("preserves repository path casing for a nested Windows workspace", () => {
    expect(
      buildGitHubFileLineUrl({
        identity: identity(),
        refName: "main",
        relativePath: "src\\Main.ts",
        workspaceRoot: "C:\\Repo\\Apps\\Web",
        repositoryRoot: "c:\\repo",
        remoteRefs: [remoteRef("main")],
        line: 9,
      }),
    ).toBe("https://github.com/t3tools/t3code/blob/main/Apps/Web/src/Main.ts#L9");
  });

  it("uses an enterprise GitHub hostname for SSH remotes", () => {
    expect(
      buildGitHubFileLineUrl({
        identity: identity({
          canonicalKey: "github.acme.test/platform/product",
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "git@github.acme.test:platform/product.git",
          },
          displayName: "platform/product",
          owner: "platform",
          name: "product",
        }),
        refName: "main",
        relativePath: "README.md",
        workspaceRoot: "/worktrees/product-task",
        remoteRefs: [remoteRef("main")],
        line: 1,
      }),
    ).toBe("https://github.acme.test/platform/product/blob/main/README.md#L1");
  });

  it("does not invent links without a GitHub repository, branch, or workspace file", () => {
    const validInput = {
      identity: identity(),
      refName: "main",
      relativePath: "src/main.ts",
      workspaceRoot: "/repo",
      repositoryRoot: "/repo",
      remoteRefs: [remoteRef("main")],
      line: 1,
    } as const;

    expect(buildGitHubFileLineUrl({ ...validInput, identity: null })).toBeNull();
    expect(
      buildGitHubFileLineUrl({
        ...validInput,
        identity: identity({ provider: "gitlab" }),
      }),
    ).toBeNull();
    expect(buildGitHubFileLineUrl({ ...validInput, refName: null })).toBeNull();
    expect(buildGitHubFileLineUrl({ ...validInput, relativePath: "/tmp/main.ts" })).toBeNull();
    expect(buildGitHubFileLineUrl({ ...validInput, relativePath: "../main.ts" })).toBeNull();
    expect(buildGitHubFileLineUrl({ ...validInput, workspaceRoot: "/other/project" })).toBeNull();
    expect(buildGitHubFileLineUrl({ ...validInput, remoteRefs: [] })).toBeNull();
    expect(
      buildGitHubFileLineUrl({ ...validInput, remoteRefs: [remoteRef("main", "fork")] }),
    ).toBeNull();
    expect(buildGitHubFileLineUrl({ ...validInput, line: 0 })).toBeNull();
  });
});
