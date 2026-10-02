import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";

import {
  HostProcessArguments,
  HostProcessExecutablePath,
  HostProcessIsExecutable,
  HostProcessPlatform,
} from "./hostProcess.ts";
import { resolveNodeExecutable, resolveSelfInvocation, selfInvocationArgs } from "./nodeRuntime.ts";
import { symlinksSupported } from "./testing/symlinks.ts";

describe("Self invocation", () => {
  it.effect("runs the entrypoint script with the current runtime", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const invocation = yield* resolveSelfInvocation().pipe(
        Effect.provideService(HostProcessExecutablePath, "/runtime/node"),
        Effect.provideService(HostProcessIsExecutable, false),
        Effect.provideService(HostProcessArguments, ["/runtime/node", "dist/bin.mjs", "serve"]),
      );
      expect(invocation.command).toBe("/runtime/node");
      expect(invocation.entrypoint).toBe(path.resolve("dist/bin.mjs"));
      expect(selfInvocationArgs(invocation, ["acp-mcp-bridge"])).toEqual([
        path.resolve("dist/bin.mjs"),
        "acp-mcp-bridge",
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("passes subcommands straight to the standalone executable", () =>
    Effect.gen(function* () {
      // Node repeats the binary at argv[1] for a single-executable; it is not a script.
      const invocation = yield* resolveSelfInvocation().pipe(
        Effect.provideService(HostProcessExecutablePath, "/packaged/t3"),
        Effect.provideService(HostProcessIsExecutable, true),
        Effect.provideService(HostProcessArguments, ["/packaged/t3", "/packaged/t3", "serve"]),
      );
      expect(invocation).toEqual({ command: "/packaged/t3", entrypoint: undefined });
      expect(selfInvocationArgs(invocation, ["acp-mcp-bridge"])).toEqual(["acp-mcp-bridge"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("Node runtime selection", () => {
  it.effect("keeps the current Node or Electron runtime without requiring Node on PATH", () =>
    Effect.gen(function* () {
      for (const executable of ["/runtime/node", "/Applications/T3 Code.app/Electron"]) {
        expect(
          yield* resolveNodeExecutable("Local device support", { PATH: "" }).pipe(
            Effect.provideService(HostProcessExecutablePath, executable),
            Effect.provideService(HostProcessIsExecutable, false),
          ),
        ).toBe(executable);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("uses installed Node instead of the standalone T3 executable", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(
        yield* resolveNodeExecutable("Local device support", {
          PATH: path.dirname(process.execPath),
        }),
      ).toBe(process.execPath);
    }).pipe(
      Effect.provideService(HostProcessExecutablePath, "/packaged/t3"),
      Effect.provideService(HostProcessIsExecutable, true),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("explains how to install Node when a standalone helper has no runtime", () =>
    Effect.gen(function* () {
      const error = yield* resolveNodeExecutable("Local device support", { PATH: "" }).pipe(
        Effect.flip,
      );
      expect(error._tag).toBe("NodeRuntimeUnavailableError");
      expect(error.message).toContain("Local device support requires Node.js");
      expect(error.message).toContain("Install Node.js");
    }).pipe(
      Effect.provideService(HostProcessIsExecutable, true),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("finds a newly installed runtime immediately after a failed lookup", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const platform = yield* HostProcessPlatform;
      const node = path.join(directory, platform === "win32" ? "node.exe" : "node");
      const env = { PATH: directory };
      expect(
        Result.isFailure(
          yield* resolveNodeExecutable("Local device support", env).pipe(Effect.result),
        ),
      ).toBe(true);
      yield* fs.copyFile(process.execPath, node);
      yield* fs.chmod(node, 0o755);
      expect(yield* resolveNodeExecutable("Local device support", env)).toBe(node);
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcessExecutablePath, "/packaged/t3"),
      Effect.provideService(HostProcessIsExecutable, true),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("uses node.exe even when Windows batch wrappers appear first on PATH", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const wrappers = path.join(directory, "wrappers");
      const runtime = path.join(directory, "runtime");
      yield* fs.makeDirectory(wrappers);
      yield* fs.makeDirectory(runtime);
      yield* fs.writeFileString(path.join(wrappers, "node.cmd"), "@echo off");
      yield* fs.writeFileString(path.join(wrappers, "node.bat"), "@echo off");
      const node = path.join(runtime, "node.exe");
      yield* fs.copyFile(process.execPath, node);
      expect(
        yield* resolveNodeExecutable("Local device support", {
          PATH: `${wrappers};${runtime}`,
          PATHEXT: ".CMD;.BAT",
        }),
      ).toBe(node);
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcessExecutablePath, "/packaged/t3"),
      Effect.provideService(HostProcessIsExecutable, true),
      Effect.provideService(HostProcessPlatform, "win32"),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("reports install guidance when Windows only has batch runtime wrappers", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(path.join(directory, "node.cmd"), "@echo off");
      yield* fs.writeFileString(path.join(directory, "node.bat"), "@echo off");
      const error = yield* resolveNodeExecutable("Local device support", {
        PATH: directory,
        PATHEXT: ".CMD;.BAT;.EXE",
      }).pipe(Effect.flip);
      expect(error._tag).toBe("NodeRuntimeUnavailableError");
      expect(error.message).toContain("Install Node.js");
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcessIsExecutable, true),
      Effect.provideService(HostProcessPlatform, "win32"),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("rejects a hard-linked node alias pointing back at the standalone app", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const platform = yield* HostProcessPlatform;
      const executable = path.join(directory, platform === "win32" ? "t3.exe" : "t3");
      const node = path.join(directory, platform === "win32" ? "node.exe" : "node");
      yield* fs.writeFileString(executable, "standalone executable fixture");
      yield* fs.chmod(executable, 0o755);
      yield* fs.link(executable, node);
      const error = yield* resolveNodeExecutable("Local device support", { PATH: directory }).pipe(
        Effect.provideService(HostProcessExecutablePath, executable),
        Effect.flip,
      );
      expect(error._tag).toBe("NodeRuntimeUnavailableError");
      expect(error.message).toContain("Install Node.js");
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcessIsExecutable, true),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect.skipIf(!symlinksSupported)("preserves the node alias used by runtime launchers", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const platform = yield* HostProcessPlatform;
      const node = path.join(directory, platform === "win32" ? "node.exe" : "node");
      yield* fs.symlink(process.execPath, node);
      expect(yield* resolveNodeExecutable("Local device support", { PATH: directory })).toBe(node);
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcessExecutablePath, "/packaged/t3"),
      Effect.provideService(HostProcessIsExecutable, true),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect.skipIf(!symlinksSupported)(
    "rejects a node alias pointing back at the standalone app",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped();
        const platform = yield* HostProcessPlatform;
        const node = path.join(directory, platform === "win32" ? "node.exe" : "node");
        yield* fs.symlink(process.execPath, node);
        const error = yield* resolveNodeExecutable("Local device support", {
          PATH: directory,
        }).pipe(Effect.flip);
        expect(error.message).toContain("Install Node.js");
      }).pipe(
        Effect.scoped,
        Effect.provideService(HostProcessIsExecutable, true),
        Effect.provide(NodeServices.layer),
      ),
  );
});
