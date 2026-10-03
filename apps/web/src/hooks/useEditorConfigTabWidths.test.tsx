import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ProjectId,
  type PullRequestDiffFileContentsInput,
} from "@t3tools/contracts";
import { AtomRegistry } from "effect/unstable/reactivity";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  files: new Map<string, string>(),
  reads: [] as string[],
  pending: new Map<string, Promise<void>>(),
  reviewFiles: new Map<string, string>(),
  reviewReads: [] as PullRequestDiffFileContentsInput[],
}));

vi.mock("../components/files/projectFilesQueryState", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  const Effect = await import("effect/Effect");
  const queries = Atom.family((key: string) =>
    Atom.make(
      Effect.suspend(() => {
        state.reads.push(key);
        const read = Effect.suspend(() => {
          const contents = state.files.get(key);
          return contents === undefined
            ? Effect.fail("File not found")
            : Effect.succeed({
                relativePath: key,
                contents,
                byteLength: contents.length,
                truncated: false,
              });
        });
        const pending = state.pending.get(key);
        return pending ? Effect.promise(() => pending).pipe(Effect.andThen(read)) : read;
      }),
    ).pipe(Atom.swr({ staleTime: 30_000, revalidateOnMount: true }), Atom.setIdleTTL(5 * 60_000)),
  );
  return {
    getProjectFileQueryAtom: (environmentId: EnvironmentId, cwd: string, path: string | null) =>
      queries(JSON.stringify([environmentId, cwd, path])),
  };
});

vi.mock("../state/pullRequests", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  const Effect = await import("effect/Effect");
  const Schema = await import("effect/Schema");
  const { EnvironmentId, PullRequestDiffFileContentsInput } = await import("@t3tools/contracts");
  const decode = Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.Tuple([EnvironmentId, PullRequestDiffFileContentsInput])),
  );
  const queries = Atom.family((key: string) =>
    Atom.make(
      Effect.suspend(() => {
        const [, input] = decode(key);
        state.reviewReads.push(input);
        const contents = state.reviewFiles.get(key);
        return contents === undefined
          ? Effect.fail("File not found in revision")
          : Effect.succeed({ oldContents: "", newContents: contents });
      }),
    ).pipe(Atom.swr({ staleTime: 60_000, revalidateOnMount: true }), Atom.setIdleTTL(5 * 60_000)),
  );
  return {
    pullRequestEnvironment: {
      diffFileContentsQuery: (request: {
        environmentId: EnvironmentId;
        input: PullRequestDiffFileContentsInput;
      }) => queries(JSON.stringify([request.environmentId, request.input])),
    },
  };
});

import { getProjectFileQueryAtom } from "../components/files/projectFilesQueryState";
import {
  useEditorConfigTabWidths,
  type PullRequestEditorConfigSource,
} from "./useEditorConfigTabWidths";

const environmentId = EnvironmentId.make("editorconfig-test");
const key = (path: string, environment = environmentId, cwd = "/repo") =>
  JSON.stringify([environment, cwd, path]);

function Widths(props: {
  environmentId?: EnvironmentId;
  cwd?: string;
  paths: string[];
  revision?: string;
  refreshToken?: string | number;
  pathRoot?: string;
  pullRequest?: PullRequestEditorConfigSource;
}) {
  const widths = useEditorConfigTabWidths(
    props.environmentId ?? environmentId,
    props.cwd ?? "/repo",
    props.paths,
    props.revision,
    props.refreshToken,
    props.pathRoot,
    props.pullRequest,
  );
  return <output>{props.paths.map((path) => widths.get(path) ?? 2).join(",")}</output>;
}

describe("workspace EditorConfig lookup", () => {
  let renderer: ReactTestRenderer | undefined;
  let registry: ReturnType<typeof AtomRegistry.make>;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    state.files.clear();
    state.reads.length = 0;
    state.pending.clear();
    state.reviewFiles.clear();
    state.reviewReads.length = 0;
    registry = AtomRegistry.make();
  });

  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = undefined;
    registry.dispose();
    vi.unstubAllGlobals();
  });

  async function mount(props: Parameters<typeof Widths>[0]) {
    await act(async () => {
      const view = (
        <RegistryContext.Provider value={registry}>
          <Widths {...props} />
        </RegistryContext.Provider>
      );
      if (renderer) renderer.update(view);
      else renderer = create(view);
    });
    return renderer!.root.findByType("output").children.join("");
  }

  it("shares sibling config reads, inherits width, and stops discovery at root=true", async () => {
    state.files.set(key(".editorconfig"), "root = true\n[*]\nindent_size = 4");
    state.files.set(key("src/.editorconfig"), "[special.ts]\ntab_width = 8");
    expect(await mount({ paths: ["src/first.ts", "src/special.ts"] })).toBe("4,8");
    expect(state.reads.filter((path) => path === key(".editorconfig"))).toHaveLength(1);
    expect(state.reads.filter((path) => path === key("src/.editorconfig"))).toHaveLength(1);
    expect(state.reads).not.toContain(key("/.editorconfig"));
  });

  it("reads PR config from its snapshot, shares ancestors, and isolates commits and hosts", async () => {
    const reference = {
      projectId: ProjectId.make("project"),
      host: "github.com",
      repository: "org/repo",
      number: 12,
    };
    const head = "a".repeat(40);
    const commit = "b".repeat(40);
    const setConfig = (source: PullRequestEditorConfigSource, path: string, contents: string) => {
      state.reviewFiles.set(
        JSON.stringify([
          environmentId,
          {
            ...source.reference,
            ...(source.commit === null ? {} : { commit: source.commit }),
            changeType: "new",
            oldPath: path,
            newPath: path,
          },
        ]),
        contents,
      );
    };
    const pullRequest = { reference, commit: head };
    state.files.set(key(".editorconfig"), "root=true\n[*]\ntab_width=2");
    setConfig(pullRequest, ".editorconfig", "[*]\ntab_width=4");
    setConfig(pullRequest, "src/.editorconfig", "[special.ts]\ntab_width=8");
    const props = { paths: ["src/file.ts", "src/special.ts"], pullRequest };
    expect(await mount(props)).toBe("4,8");
    expect(state.reads).toEqual([]);
    expect(state.reviewReads).toHaveLength(2);
    expect(
      state.reviewReads.every((read) => read.commit === head && read.changeType === "new"),
    ).toBe(true);
    const earlier = { reference, commit };
    setConfig(earlier, ".editorconfig", "root=true\n[*]\ntab_width=3");
    expect(await mount({ ...props, pullRequest: earlier })).toBe("3,3");
    const otherHost = { reference: { ...reference, host: "github.enterprise.test" }, commit: head };
    setConfig(otherHost, ".editorconfig", "root=true\n[*]\ntab_width=6");
    expect(await mount({ ...props, pullRequest: otherHost })).toBe("6,6");
    expect(await mount(props)).toBe("4,8");
    // Missing configs never inherit a local checkout's unrelated configuration.
    state.files.set(key(".editorconfig"), "root=true\n[*]\ntab_width=8");
    expect(await mount({ ...props, pullRequest: { reference, commit: "c".repeat(40) } })).toBe(
      "2,2",
    );
    expect(state.reads).toEqual([]);
  });

  it("refreshes an unpinned PR snapshot only through the existing refresh token", async () => {
    const reference = { projectId: ProjectId.make("project"), repository: "org/repo", number: 12 };
    const pullRequest = { reference, commit: null };
    const configKey = JSON.stringify([
      environmentId,
      { ...reference, changeType: "new", oldPath: ".editorconfig", newPath: ".editorconfig" },
    ]);
    state.reviewFiles.set(configKey, "root=true\n[*]\ntab_width=4");
    const props = { paths: ["file.ts"], pullRequest, refreshToken: 1 };
    expect(await mount(props)).toBe("4");
    state.reviewFiles.set(configKey, "root=true\n[*]\ntab_width=8");
    expect(await mount(props)).toBe("4");
    expect(await mount({ ...props, refreshToken: 2 })).toBe("8");
  });

  it("keeps environments and workspaces isolated when paths have the same name", async () => {
    const remote = EnvironmentId.make("editorconfig-remote");
    state.files.set(key(".editorconfig"), "root=true\n[*]\ntab_width=4");
    state.files.set(key(".editorconfig", remote), "root=true\n[*]\ntab_width=8");
    state.files.set(key(".editorconfig", environmentId, "/other"), "root=true\n[*]\nindent_size=3");
    expect(await mount({ paths: ["file.ts"] })).toBe("4");
    expect(await mount({ paths: ["file.ts"], environmentId: remote })).toBe("8");
    expect(await mount({ paths: ["file.ts"], cwd: "/other" })).toBe("3");
  });

  it.each([
    ["/repo/frontend", "/repo", "/repo/.editorconfig"],
    ["C:\\repo\\frontend", "C:\\repo", "C:/repo/.editorconfig"],
    ["\\\\host\\share\\repo\\frontend", "\\\\host\\share\\repo", "//host/share/repo/.editorconfig"],
    ["//HOST/share/repo/frontend", "//host/share/repo", "//host/share/repo/.editorconfig"],
    ["/worktrees/feature/frontend", "/worktrees/feature", "/worktrees/feature/.editorconfig"],
  ])(
    "resolves repository-relative diff paths for nested workspace %s",
    async (cwd, pathRoot, ancestor) => {
      const props = { cwd, pathRoot, paths: ["frontend/src/renamed.ts", "backend/other.ts"] };
      state.files.set(key(ancestor, environmentId, cwd), "root=true\n[*]\ntab_width=4");
      state.files.set(key("src/.editorconfig", environmentId, cwd), "[renamed.ts]\ntab_width=8");
      expect(await mount(props)).toBe("8,4");
      expect(state.reads).toContain(key("src/.editorconfig", environmentId, cwd));
      expect(state.reads).not.toContain(key("frontend/src/.editorconfig", environmentId, cwd));
      state.files.set(key("src/.editorconfig", environmentId, cwd), "[renamed.ts]\ntab_width=6");
      await act(async () =>
        registry.refresh(getProjectFileQueryAtom(environmentId, cwd, "src/.editorconfig")),
      );
      expect(renderer!.root.findByType("output").children.join("")).toBe("6,4");
    },
  );

  it("invalidates fresh SWR queries for collapsed files on an existing refresh", async () => {
    state.files.set(key(".editorconfig"), "root=true\n[*]\ntab_width=4");
    expect(await mount({ paths: ["src/file.ts"], revision: "same", refreshToken: 0 })).toBe("4");
    expect(await mount({ paths: [], revision: "same", refreshToken: 0 })).toBe("");
    state.files.set(key(".editorconfig"), "root=true\n[*]\ntab_width=8");
    state.reads.length = 0;
    await mount({ paths: [], revision: "same", refreshToken: 1 });
    expect(await mount({ paths: ["src/file.ts"], revision: "same", refreshToken: 1 })).toBe("8");
    expect(state.reads).toContain(key(".editorconfig"));
  });

  it("forgets collapsed queries when switching environment or workspace", async () => {
    const remote = EnvironmentId.make("collapsed-remote");
    state.files.set(key(".editorconfig"), "root=true\n[*]\ntab_width=4");
    await mount({ paths: ["src/file.ts"], refreshToken: 0 });
    await mount({ paths: [], refreshToken: 0 });
    for (const scope of [{ environmentId: remote }, { cwd: "/other" }]) {
      await mount({ paths: [], ...scope, refreshToken: 0 });
      state.reads.length = 0;
      await mount({ paths: [], ...scope, refreshToken: 1 });
      expect(state.reads).toEqual([]);
    }
  });

  it("reacts to config refresh and workspace mutation, including newly created configs", async () => {
    state.files.set(key(".editorconfig"), "root=true\n[*]\ntab_width=4");
    expect(await mount({ paths: ["src/file.ts"], revision: "one" })).toBe("4");
    state.files.set(key(".editorconfig"), "root=true\n[*]\ntab_width=6");
    await act(async () =>
      registry.refresh(getProjectFileQueryAtom(environmentId, "/repo", ".editorconfig")),
    );
    expect(renderer!.root.findByType("output").children.join("")).toBe("6");
    state.files.set(key("src/.editorconfig"), "[*]\ntab_width=8");
    expect(await mount({ paths: ["src/file.ts"], revision: "two" })).toBe("8");
  });

  it("uses the workspace-relative refresh performed after an in-app config save", async () => {
    state.files.set(key(".editorconfig"), "root=true\n[*]\ntab_width=4");
    expect(await mount({ paths: ["src/file.ts"] })).toBe("4");
    state.files.set(key(".editorconfig"), "root=true\n[*]\ntab_width=8");
    await act(async () => {
      registry.refresh(getProjectFileQueryAtom(environmentId, "/repo", ".editorconfig"));
    });
    expect(renderer!.root.findByType("output").children.join("")).toBe("8");
    expect(state.reads).not.toContain(key("/repo/.editorconfig"));
  });

  it.each([
    ["working-tree preview completion", "2026-10-03T12:00:00Z", "2026-10-03T12:01:00Z"],
    ["pull request refresh", 0, 1],
  ])("refreshes ancestors on %s with unchanged content revision", async (_label, first, next) => {
    const paths = ["src/first.ts", "lib/second.ts"];
    state.files.set(key("/.editorconfig"), "root=true\n[*]\ntab_width=4");
    expect(await mount({ paths, revision: "unchanged", refreshToken: first })).toBe("4,4");
    state.files.set(key("/.editorconfig"), "root=true\n[*]\ntab_width=8");
    expect(await mount({ paths, revision: "unchanged", refreshToken: first })).toBe("4,4");
    state.reads.length = 0;
    expect(await mount({ paths, revision: "unchanged", refreshToken: next })).toBe("8,8");
    expect(state.reads.filter((path) => path === key("/.editorconfig"))).toHaveLength(1);
    // Checkpoint mutations must still refresh independently of the completed-preview token.
    state.files.set(key("/.editorconfig"), "root=true\n[*]\nindent_size=3");
    expect(await mount({ paths, revision: "mutation", refreshToken: next })).toBe("3,3");
  });

  it("refreshes only the active environment and resolved diff workspace, retaining width while pending", async () => {
    const remote = EnvironmentId.make("diff-remote");
    const cwd = "/fallback/repository";
    const props = { paths: ["file.ts"], environmentId: remote, cwd, revision: "unchanged" };
    state.files.set(key(".editorconfig"), "root=true\n[*]\ntab_width=3");
    state.files.set(key("/fallback/.editorconfig", remote, cwd), "root=true\n[*]\ntab_width=4");
    expect(await mount({ paths: ["file.ts"], refreshToken: 0 })).toBe("3");
    expect(await mount({ ...props, refreshToken: 0 })).toBe("4");
    state.reads.length = 0;
    let finish!: () => void;
    state.pending.set(
      key("/fallback/.editorconfig", remote, cwd),
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    state.files.delete(key("/fallback/.editorconfig", remote, cwd));
    expect(await mount({ ...props, refreshToken: 1 })).toBe("4");
    await act(async () => finish());
    expect(renderer!.root.findByType("output").children.join("")).toBe("2");
    expect(state.reads.length).toBeGreaterThan(0);
    expect(
      state.reads.every((read) => {
        const [environment, workspace] = JSON.parse(read);
        return environment === remote && workspace === cwd;
      }),
    ).toBe(true);
  });

  it("keeps resolved widths while workspace queries revalidate", async () => {
    state.files.set(key(".editorconfig"), "root=true\n[*]\ntab_width=4");
    expect(await mount({ paths: ["src/file.ts"], revision: "one" })).toBe("4");
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    state.pending.set(key("src/.editorconfig"), pending);
    state.pending.set(key(".editorconfig"), pending);
    state.files.set(key(".editorconfig"), "root=true\n[*]\ntab_width=8");
    expect(await mount({ paths: ["src/file.ts"], revision: "two" })).toBe("4");
    await act(async () => finish());
    expect(renderer!.root.findByType("output").children.join("")).toBe("8");
  });

  it("uses the fallback only while the first config read is unresolved", async () => {
    state.files.set(key(".editorconfig"), "root=true\n[*]\ntab_width=8");
    let finish!: () => void;
    state.pending.set(
      key(".editorconfig"),
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    expect(await mount({ paths: ["file.ts"] })).toBe("2");
    await act(async () => finish());
    expect(renderer!.root.findByType("output").children.join("")).toBe("8");
  });

  it("drops a deleted root config after an existing refresh and discovers its parent", async () => {
    state.files.set(key(".editorconfig"), "root=true\n[*]\ntab_width=8");
    state.files.set(key("/.editorconfig"), "root=true\n[*]\ntab_width=4");
    expect(await mount({ paths: ["file.ts"], revision: "one" })).toBe("8");
    expect(state.reads).not.toContain(key("/.editorconfig"));
    state.files.delete(key(".editorconfig"));
    let finish!: () => void;
    state.pending.set(
      key(".editorconfig"),
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    expect(await mount({ paths: ["file.ts"], revision: "two" })).toBe("8");
    await act(async () => finish());
    expect(renderer!.root.findByType("output").children.join("")).toBe("4");
    state.pending.set(
      key(".editorconfig"),
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    expect(await mount({ paths: ["file.ts"], revision: "three" })).toBe("4");
    await act(async () => finish());
    expect(renderer!.root.findByType("output").children.join("")).toBe("4");
  });

  it("returns to the default after the last config is deleted and refreshed", async () => {
    state.files.set(key(".editorconfig"), "root=true\n[*]\ntab_width=8");
    expect(await mount({ paths: ["file.ts"], revision: "one" })).toBe("8");
    state.files.delete(key(".editorconfig"));
    expect(await mount({ paths: ["file.ts"], revision: "two" })).toBe("2");
    let finish!: () => void;
    state.pending.set(
      key(".editorconfig"),
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    expect(await mount({ paths: ["file.ts"], revision: "three" })).toBe("2");
    await act(async () => finish());
    expect(renderer!.root.findByType("output").children.join("")).toBe("2");
    state.files.set(key(".editorconfig"), "root=true\n[*]\ntab_width=4");
    expect(await mount({ paths: ["file.ts"], revision: "four" })).toBe("4");
  });

  it("falls back for absent configs and resolves large numeric ranges", async () => {
    expect(await mount({ paths: ["file.ts"] })).toBe("2");
    state.files.set(key(".editorconfig"), "root=true\n[file{1..1000000}.ts]\ntab_width=8");
    expect(await mount({ paths: ["file999999.ts"], revision: "changed" })).toBe("8");
  });
});
