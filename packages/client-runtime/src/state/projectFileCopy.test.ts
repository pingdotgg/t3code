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
  defaultCopiedFilePaths,
  projectSubdirectory,
  readProjectFilesToCopy,
  writeProjectFilesAfterClone,
} from "./projectFileCopy.ts";

const environmentId = EnvironmentId.make("server");
const projectId = ProjectId.make("clone");

describe("defaultCopiedFilePaths", () => {
  it("preselects env files that fit the read cap", () => {
    const file = (path: string, byteLength = 10) => ({ path, byteLength });
    expect([
      ...defaultCopiedFilePaths([
        file(".env"),
        file("apps/web/.env.local"),
        file(".envrc"),
        file(".dev.vars"),
        file("notes.txt"),
        file("env.example"),
        file("big/.env", COPYABLE_FILE_MAX_BYTES + 1),
      ]),
    ]).toEqual([".env", "apps/web/.env.local", ".envrc", ".dev.vars"]);
  });
});

describe("projectSubdirectory", () => {
  it("is the project's path below its repository root", () => {
    expect(projectSubdirectory("/repo", "/repo/apps/web")).toBe("apps/web");
    expect(projectSubdirectory("C:\\repo\\", "C:\\repo\\apps\\web")).toBe("apps/web");
    expect(projectSubdirectory("/repo", "/repo")).toBe("");
    expect(projectSubdirectory("/repo", "/repo-other/apps")).toBe("");
    expect(projectSubdirectory(undefined, "/repo/apps/web")).toBe("");
  });
});

describe("copying files to a cloned project", () => {
  const clone = (phase: ProjectCloneSnapshot["phase"]) =>
    [{ projectId, phase }] as unknown as ReadonlyArray<ProjectCloneSnapshot>;

  function setup() {
    const registry = AtomRegistry.make();
    const clonesAtom = Atom.make<ReadonlyArray<ProjectCloneSnapshot>>([]);
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

  it("copies nothing when the clone is removed before it finishes", async () => {
    const { registry, clonesAtom, writes, copy } = setup();
    const copied = copy("");
    registry.set(clonesAtom, clone("running"));
    registry.set(clonesAtom, []);

    expect(await copied).toBeNull();
    expect(writes).toEqual([]);
  });
});
