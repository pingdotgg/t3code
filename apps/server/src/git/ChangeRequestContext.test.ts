import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as VcsProjectConfig from "../vcs/VcsProjectConfig.ts";
import { readChangeRequestContext } from "./ChangeRequestContext.ts";

it.live.each([
  "invalid-json",
  "invalid-paths",
  "too-many-files",
  "script-failed",
  "outside-checkout",
  "outside-symlink",
  "directory",
  "binary",
  "invalid-utf8",
  "oversized",
] as const)("rejects unusable project context: %s", (scenario) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mr-context-" });
    yield* fs.makeDirectory(path.join(cwd, ".t3code"));
    let script = 'console.log(JSON.stringify(["context.txt"]));';
    switch (scenario) {
      case "invalid-json":
        script = 'console.log("not json");';
        break;
      case "invalid-paths":
        script = 'console.log(JSON.stringify({ files: ["context.txt"] }));';
        break;
      case "too-many-files":
        script = "console.log(JSON.stringify(Array.from({length: 17}, (_, i) => `${i}.txt`)));";
        break;
      case "script-failed":
        script = "process.exitCode = 1;";
        break;
      case "outside-checkout":
        script = 'console.log(JSON.stringify(["../context.txt"]));';
        break;
      case "outside-symlink": {
        const outside = yield* fs.makeTempFileScoped();
        yield* fs.symlink(outside, path.join(cwd, "context.txt"));
        break;
      }
      case "directory":
        yield* fs.makeDirectory(path.join(cwd, "context.txt"));
        break;
      case "binary":
        yield* fs.writeFile(path.join(cwd, "context.txt"), new Uint8Array([65, 0, 66]));
        break;
      case "invalid-utf8":
        yield* fs.writeFile(path.join(cwd, "context.txt"), new Uint8Array([255]));
        break;
      case "oversized":
        yield* fs.writeFileString(path.join(cwd, "context.txt"), "x".repeat(128_001));
        break;
    }
    yield* fs.writeFileString(
      path.join(cwd, ".t3code/vcs.json"),
      JSON.stringify({ hooks: { changeRequestContext: ["node", "-e", script] } }),
    );
    const result = yield* readChangeRequestContext({
      cwd,
      headBranch: "feature/context",
      baseBranch: "main",
    }).pipe(Effect.result);
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "GitManagerError", operation: "readChangeRequestContext" },
    });
  }).pipe(
    Effect.provide(
      Layer.merge(VcsProcess.layer, VcsProjectConfig.layer).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);
