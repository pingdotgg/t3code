import {
  EnvironmentId,
  ProjectId,
  type ProjectCloneSnapshot,
  type ProjectReadFileResult,
  type ProjectWriteFileInput,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  COPYABLE_FILE_MAX_BYTES,
  defaultCopiedFiles,
  projectSubdirectory,
  readProjectFilesToCopy,
  writeProjectFilesAfterClone,
} from "./projectFileCopy.ts";

const environmentId = EnvironmentId.make("server");
const projectId = ProjectId.make("clone");

describe("defaultCopiedFiles", () => {
  it("preselects env files that fit the read cap", () => {
    const file = (path: string, byteLength = 10) => ({ path, byteLength });
    expect([
      ...defaultCopiedFiles([
        file(".env"),
        file("apps/web/.env.local"),
        file(".envrc"),
        file(".dev.vars"),
        file("notes.txt"),
        file("env.example"),
        file("big/.env", COPYABLE_FILE_MAX_BYTES + 1),
      ]).keys(),
    ]).toEqual([".env", "apps/web/.env.local", ".envrc", ".dev.vars"]);
  });
});

describe("projectSubdirectory", () => {
  it("is the project's path below its repository root", () => {
    expect(projectSubdirectory("/repo", "/repo/apps/web")).toBe("apps/web");
    expect(projectSubdirectory("C:\\repo\\", "C:\\repo\\apps\\web")).toBe("apps/web");
    expect(projectSubdirectory("C:/repo", "C:\\repo\\apps\\web")).toBe("apps/web");
    expect(projectSubdirectory("C:/Repo", "c:\\repo\\apps\\Web")).toBe("apps/Web");
    expect(projectSubdirectory("/Repo", "/repo/apps/web")).toBe("");
    expect(projectSubdirectory("/repo", "/repo")).toBe("");
    expect(projectSubdirectory("/repo", "/repo-other/apps")).toBe("");
    expect(projectSubdirectory(undefined, "/repo/apps/web")).toBe("");
  });
});

describe("copying files to a cloned project", () => {
  type Clones = AsyncResult.AsyncResult<ReadonlyArray<ProjectCloneSnapshot>, unknown>;
  const list = (clones: ReadonlyArray<unknown>): Clones =>
    AsyncResult.success(clones as ReadonlyArray<ProjectCloneSnapshot>);
  const clone = (phase: ProjectCloneSnapshot["phase"]) => list([{ projectId, phase }]);

  function setup() {
    const registry = AtomRegistry.make();
    const clonesAtom = Atom.make<Clones>(AsyncResult.initial());
    const writes: Array<ProjectWriteFileInput> = [];
    const writeFile = {
      label: "write",
      run: async (_registry: unknown, target: { readonly input: ProjectWriteFileInput }) => {
        writes.push(target.input);
        return target.input.relativePath.endsWith("locked")
          ? AsyncResult.failure(Cause.fail(new Error("denied")))
          : AsyncResult.success(undefined);
      },
    };
    const copy = (subdirectory: string) =>
      writeProjectFilesAfterClone(
        registry,
        { writeFile },
        {
          clonesAtom,
          environmentId,
          projectId,
          cwd: "/srv/repo",
          subdirectory,
          reads: [
            { relativePath: ".env", contents: "A=1" },
            { relativePath: "huge", error: "Too large to copy." },
            { relativePath: "locked", contents: "B=2" },
          ],
        },
      );
    return { registry, clonesAtom, writes, copy };
  }

  it("reads each file, reporting the ones that cannot be copied whole", async () => {
    const results: Record<string, Partial<ProjectReadFileResult>> = {
      ".env": { contents: "A=1", truncated: false },
      huge: { contents: "x", truncated: true },
    };
    const reads = await readProjectFilesToCopy(
      AtomRegistry.make(),
      {
        readFile: ({ input }) => {
          const result: AsyncResult.AsyncResult<ProjectReadFileResult, unknown> =
            input.relativePath in results
              ? AsyncResult.success(results[input.relativePath] as ProjectReadFileResult)
              : AsyncResult.failure(Cause.fail(new Error("gone")));
          return Atom.make(result);
        },
      },
      { environmentId, cwd: "/work/repo" },
      [".env", "huge", "missing"],
    );
    expect(reads).toEqual([
      { relativePath: ".env", contents: "A=1" },
      { relativePath: "huge", error: "Too large to copy." },
      { relativePath: "missing", error: "gone" },
    ]);
  });

  it("writes below the project's subdirectory once the clone is done, and lists what failed", async () => {
    const { registry, clonesAtom, writes, copy } = setup();
    const copied = copy("apps/web");
    registry.set(clonesAtom, clone("running"));
    registry.set(clonesAtom, clone("failed"));
    expect(writes).toEqual([]);
    registry.set(clonesAtom, clone("done"));

    expect(await copied).toEqual(["huge: Too large to copy.", "locked: denied"]);
    expect(writes).toEqual([
      { cwd: "/srv/repo", relativePath: "apps/web/.env", contents: "A=1" },
      { cwd: "/srv/repo", relativePath: "apps/web/locked", contents: "B=2" },
    ]);
  });

  it("keeps waiting while the clone list is unavailable, and reports every file once the clone is gone", async () => {
    const { registry, clonesAtom, writes, copy } = setup();
    const copied = copy("");
    registry.set(clonesAtom, clone("running"));
    registry.set(clonesAtom, AsyncResult.failure(Cause.fail(new Error("disconnected"))));
    registry.set(clonesAtom, AsyncResult.initial());
    registry.set(clonesAtom, clone("running"));
    registry.set(clonesAtom, list([]));

    expect(await copied).toEqual([
      ".env: The clone was gone before this file could be copied.",
      "huge: The clone was gone before this file could be copied.",
      "locked: The clone was gone before this file could be copied.",
    ]);
    expect(writes).toEqual([]);
  });
});
