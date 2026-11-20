import { describe, expect, it } from "vite-plus/test";

import type { ProjectFiles } from "./boardFiles";
import { type Artifact, listArtifacts, readmeTarget } from "./artifacts";

const ROOT = "/p/app";
const WORKTREE = "/w/t-1";

/** An engine that lists a tree by `cwd` and project-relative directory, and refuses an absolute one as the real engine does. */
function engine(tree: Readonly<Record<string, ReadonlyArray<string>>>) {
  const calls: Array<{ cwd: string; directory: string }> = [];
  const files: ProjectFiles = {
    list: async (cwd, directory) => {
      calls.push({ cwd, directory });
      if (directory.startsWith("/")) throw new Error("path must be relative to the project");
      const prefix = `${cwd}:${directory}/`;
      const children = new Map<string, "file" | "directory">();
      for (const path of tree[cwd] ?? []) {
        const full = `${cwd}:${path}`;
        if (!full.startsWith(prefix)) continue;
        const rest = full.slice(prefix.length);
        const [head = ""] = rest.split("/");
        children.set(head, rest.includes("/") ? "directory" : "file");
      }
      if (children.size === 0) return null;
      return [...children].map(([name, kind]) => ({ path: `${directory}/${name}`, kind }));
    },
    read: async () => null,
    write: async () => undefined,
  };
  return { files, calls };
}

const BOARD = ".agentboard/main";
const tree = {
  [ROOT]: [
    `${BOARD}/board.json`,
    `${BOARD}/tickets.json`,
    `${BOARD}/design.md`,
    `${BOARD}/decisions.tsv`,
    `${BOARD}/roles/task.md`,
    `${BOARD}/artifacts/T-1/shot.png`,
    `${BOARD}/artifacts/T-1/fix1/proof.txt`,
    `${BOARD}/artifacts/T-1/.cache`,
    `${BOARD}/review/T-1/round-1.md`,
    `${BOARD}/inbox/note.md`,
  ],
  [WORKTREE]: [".omp/artifacts/T-1/worktree-proof.txt", "src/app.ts"],
};

describe("listArtifacts", () => {
  it("Given a store with evidence, when it is listed, then each artifact has its kind, ticket, and absolute path", async () => {
    const { files } = engine(tree);
    const listed = await listArtifacts(files, {
      workspaceRoot: ROOT,
      folder: "main",
      worktreePaths: [],
    });
    expect(listed.map((a) => [a.path, a.kind, a.ticketKey, a.absolutePath])).toEqual([
      [
        "artifacts/T-1/fix1/proof.txt",
        "proof",
        "T-1",
        `${ROOT}/${BOARD}/artifacts/T-1/fix1/proof.txt`,
      ],
      ["artifacts/T-1/shot.png", "screenshot", "T-1", `${ROOT}/${BOARD}/artifacts/T-1/shot.png`],
      ["decisions.tsv", "decisions", null, `${ROOT}/${BOARD}/decisions.tsv`],
      ["design.md", "design", null, `${ROOT}/${BOARD}/design.md`],
      ["inbox/note.md", "brief", null, `${ROOT}/${BOARD}/inbox/note.md`],
      ["review/T-1/round-1.md", "review", "T-1", `${ROOT}/${BOARD}/review/T-1/round-1.md`],
    ]);
  });

  it("Given a ticket worktree with evidence, when it is listed, then the worktree is the cwd and no absolute path is sent", async () => {
    const { files, calls } = engine(tree);
    const listed = await listArtifacts(files, {
      workspaceRoot: ROOT,
      folder: "main",
      worktreePaths: [WORKTREE, `${WORKTREE}/`],
    });
    expect(listed.find((a) => a.name === "worktree-proof.txt")).toMatchObject({
      kind: "proof",
      ticketKey: "T-1",
      absolutePath: `${WORKTREE}/.omp/artifacts/T-1/worktree-proof.txt`,
    });
    expect(calls.filter((call) => call.cwd === WORKTREE).map((call) => call.directory)).toEqual([
      ".omp/artifacts",
      ".omp/artifacts/T-1",
    ]);
    expect(calls.every((call) => !call.directory.startsWith("/"))).toBe(true);
  });

  it("Given a worktree the engine cannot list, when the board is listed, then the board's own artifacts still come back", async () => {
    const { files } = engine(tree);
    const failing: ProjectFiles = {
      ...files,
      list: (cwd, directory) =>
        cwd === "/w/gone"
          ? Promise.reject(new Error("workspace root not found"))
          : files.list(cwd, directory),
    };
    const listed = await listArtifacts(failing, {
      workspaceRoot: ROOT,
      folder: "main",
      worktreePaths: ["/w/gone"],
    });
    expect(listed).toHaveLength(6);
  });

  it("Given a board folder that does not exist, when it is listed, then there are no artifacts", async () => {
    const { files } = engine({});
    expect(
      await listArtifacts(files, { workspaceRoot: ROOT, folder: "none", worktreePaths: [] }),
    ).toEqual([]);
  });
});

describe("readmeTarget", () => {
  const at = (absolutePath: string): Artifact => ({
    absolutePath,
    path: absolutePath,
    name: absolutePath.slice(absolutePath.lastIndexOf("/") + 1),
    kind: "proof",
    ticketKey: "T-1",
  });
  const readme = at("/s/artifacts/T-1/README.txt");
  const shot = at("/s/artifacts/T-1/pr-screenshots/a.png");
  const sibling = at("/s/artifacts/T-1/b.txt");

  it("Given README lines naming a nested file, a sibling, and one that is not listed, when they are resolved, then only the listed files resolve", () => {
    const all = [readme, shot, sibling];
    expect(readmeTarget(readme, "pr-screenshots/a.png", all)).toBe(shot);
    expect(readmeTarget(readme, "./b.txt", all)).toBe(sibling);
    expect(readmeTarget(readme, "../T-1/b.txt", all)).toBe(sibling);
    expect(readmeTarget(readme, "gone.txt", all)).toBeUndefined();
  });
});
