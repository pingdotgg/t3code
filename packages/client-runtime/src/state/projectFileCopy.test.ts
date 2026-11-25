import {
  EnvironmentId,
  ProjectId,
  type ProjectCloneSnapshot,
  type ProjectReadFileResult,
  type ProjectWriteFileInput,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
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

class WriteDenied extends Schema.TaggedError<WriteDenied>()("WriteDenied", {
  message: Schema.String,
}) {}

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
    const sessionGenerationAtom = Atom.make(1);
    const writes: Array<ProjectWriteFileInput> = [];
    const writeFile = {
      label: "write",
      run: (_registry: unknown, target: { readonly input: ProjectWriteFileInput }) =>
        Effect.suspend(() => {
          writes.push(target.input);
          return target.input.relativePath.endsWith("locked")
            ? Effect.fail(new WriteDenied({ message: "denied" }))
            : Effect.void;
        }),
    };
    const copy = (subdirectory: string) =>
      writeProjectFilesAfterClone(
        registry,
        { writeFile },
        {
          clonesAtom,
          sessionGenerationAtom,
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
    return { registry, clonesAtom, sessionGenerationAtom, writes, copy };
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

  it("trusts a missing clone only on a list sent after it started", async () => {
    const cached = setup();
    cached.registry.set(cached.clonesAtom, list([]));
    const copied = cached.copy("");
    cached.registry.set(cached.clonesAtom, clone("done"));
    expect(await copied).toEqual(["huge: Too large to copy.", "locked: denied"]);

    const resubscribed = setup();
    resubscribed.registry.set(resubscribed.clonesAtom, list([]));
    const missed = resubscribed.copy("");
    resubscribed.registry.set(resubscribed.clonesAtom, AsyncResult.initial());
    resubscribed.registry.set(resubscribed.clonesAtom, list([]));
    expect(await missed).toHaveLength(3);
    expect(resubscribed.writes).toEqual([]);

    // A durable subscription keeps Success across a session replacement.
    const reconnected = setup();
    reconnected.registry.set(reconnected.clonesAtom, list([]));
    const away = reconnected.copy("");
    reconnected.registry.set(reconnected.sessionGenerationAtom, 2);
    reconnected.registry.set(reconnected.clonesAtom, list([]));
    expect(await away).toHaveLength(3);
    expect(reconnected.writes).toEqual([]);
  });
});
