import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectEntry } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as WorkspaceSearchIndex from "./WorkspaceSearchIndex.ts";

/**
 * ProjectEntry.path is a TrimmedNonEmptyString, so a path segment with leading
 * or trailing whitespace ("notes.txt\n") collapses onto its trimmed twin once
 * it crosses the wire. The client's file tree throws `Duplicate path: "..."`
 * on the resulting adjacent pair and renders nothing. The index must therefore
 * only emit entries whose full ancestor chain the wire contract can represent.
 */
const listEntriesOf = Effect.fn(function* (files: ReadonlyArray<string>) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-dup-path-" });
  for (const relativePath of files) {
    const absolutePath = path.join(root, relativePath);
    yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
    yield* fileSystem.writeFileString(absolutePath, "");
  }
  const index = yield* WorkspaceSearchIndex.make(root);
  return yield* index.list();
});

function encodedPaths(entries: ReadonlyArray<ProjectEntry>): ReadonlyArray<string> {
  const encode = Schema.encodeUnknownSync(Schema.Array(ProjectEntry));
  return encode(entries).map((entry) => entry.path);
}

it.effect("drops a file whose name collapses onto a sibling's after trimming", () =>
  Effect.gen(function* () {
    const { entries } = yield* listEntriesOf(["pkg/notes.txt", "pkg/notes.txt\n"]);
    const notes = entries.filter((entry) => entry.path.includes("notes.txt"));

    expect(notes).toEqual([{ path: "pkg/notes.txt", kind: "file" }]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("drops the whole subtree under a directory the wire cannot represent", () =>
  Effect.gen(function* () {
    const { entries } = yield* listEntriesOf(["sub/inner.txt", "sub\n/inner.txt"]);

    expect(entries).toEqual([
      { path: "sub", kind: "directory" },
      { path: "sub/inner.txt", kind: "file" },
    ]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("never emits two entries that encode to the same wire path", () =>
  Effect.gen(function* () {
    const { entries } = yield* listEntriesOf([
      "pkg/notes.txt",
      "pkg/notes.txt\n",
      "pkg/ notes.txt",
    ]);
    const wirePaths = encodedPaths(entries);
    const duplicates = wirePaths.filter((path, index) => wirePaths.indexOf(path) !== index);

    expect(duplicates).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
