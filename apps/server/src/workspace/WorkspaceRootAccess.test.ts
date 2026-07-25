import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as WorkspaceRootAccess from "./WorkspaceRootAccess.ts";

const authorize = (input: {
  readonly workspaceRoot: string;
  readonly registeredRoots: ReadonlyArray<string>;
}) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return yield* WorkspaceRootAccess.authorizeWorkspaceRoot({ ...input, path });
  });

it.effect("accepts a registered workspace root", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const projectDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-root-access-" });

    const authorized = yield* authorize({
      workspaceRoot: projectDir,
      registeredRoots: [projectDir],
    });

    assert.equal(authorized, projectDir);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("accepts a directory nested inside a registered workspace root", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const projectDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-root-access-" });
    const nested = path.join(projectDir, "packages", "server");
    yield* fs.makeDirectory(nested, { recursive: true });

    const authorized = yield* authorize({
      workspaceRoot: nested,
      registeredRoots: [projectDir],
    });

    assert.equal(authorized, nested);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("rejects a directory that is not registered", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const projectDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-root-access-" });
    const otherDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-root-access-other-" });

    const error = yield* Effect.flip(
      authorize({ workspaceRoot: otherDir, registeredRoots: [projectDir] }),
    );

    assert.equal(error._tag, "WorkspaceRootNotRegisteredError");
    assert.equal(error.workspaceRoot, otherDir);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("rejects everything when no project is registered", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const projectDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-root-access-" });

    const error = yield* Effect.flip(authorize({ workspaceRoot: projectDir, registeredRoots: [] }));

    assert.equal(error._tag, "WorkspaceRootNotRegisteredError");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("rejects a sibling directory that merely shares a name prefix", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-root-access-" });
    const projectDir = path.join(parent, "app");
    const lookalike = path.join(parent, "app-secrets");
    yield* fs.makeDirectory(projectDir);
    yield* fs.makeDirectory(lookalike);

    const error = yield* Effect.flip(
      authorize({ workspaceRoot: lookalike, registeredRoots: [projectDir] }),
    );

    assert.equal(error._tag, "WorkspaceRootNotRegisteredError");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("rejects a symlink inside a registered root that escapes it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const projectDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-root-access-" });
    const outsideDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-root-access-outside-" });
    const escapeLink = path.join(projectDir, "escape");
    yield* fs.symlink(outsideDir, escapeLink);

    const error = yield* Effect.flip(
      authorize({ workspaceRoot: escapeLink, registeredRoots: [projectDir] }),
    );

    assert.equal(error._tag, "WorkspaceRootNotRegisteredError");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("accepts a request that reaches a registered root through a symlink", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-root-access-" });
    const projectDir = path.join(parent, "project");
    const linkToProject = path.join(parent, "link");
    yield* fs.makeDirectory(projectDir);
    yield* fs.symlink(projectDir, linkToProject);

    const authorized = yield* authorize({
      workspaceRoot: linkToProject,
      registeredRoots: [projectDir],
    });

    assert.equal(authorized, linkToProject);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("accepts a request against a root that is itself registered through a symlink", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-root-access-" });
    const projectDir = path.join(parent, "project");
    const linkToProject = path.join(parent, "link");
    yield* fs.makeDirectory(projectDir);
    yield* fs.symlink(projectDir, linkToProject);

    const authorized = yield* authorize({
      workspaceRoot: projectDir,
      registeredRoots: [linkToProject],
    });

    assert.equal(authorized, projectDir);
  }).pipe(Effect.provide(NodeServices.layer)),
);
