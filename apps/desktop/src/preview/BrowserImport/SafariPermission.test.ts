import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import { safariPermissionCheck } from "./SafariPermission.ts";

it.effect("detects Safari access becoming available without reading or importing cookies", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-safari-access-" });
    const directory = `${home}/Library/Containers/com.apple.Safari/Data/Library/Cookies`;
    yield* fs.makeDirectory(directory, { recursive: true });
    const jar = `${directory}/Cookies.binarycookies`;
    yield* fs.writeFileString(jar, "not a valid cookie database");
    let allowed = false;
    const guardedFs = FileSystem.FileSystem.of({
      ...fs,
      open: (path, options) =>
        allowed
          ? fs.open(path, options)
          : Effect.fail(
              PlatformError.systemError({
                _tag: "Unknown",
                module: "FileSystem",
                method: "open",
                cause: Object.assign(new Error("operation not permitted"), { code: "EPERM" }),
              }),
            ),
    });
    const check = yield* safariPermissionCheck.pipe(
      Effect.provideService(HostProcessEnvironment, { HOME: home }),
      Effect.provideService(HostProcessPlatform, "darwin"),
      Effect.provideService(FileSystem.FileSystem, guardedFs),
    );
    assert.isFalse(yield* Effect.promise(check));
    allowed = true;
    assert.isTrue(yield* Effect.promise(check));
    yield* fs.remove(jar);
    assert.isFalse(yield* Effect.promise(check));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("recognizes access when cookies exist only in a named Safari profile", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-safari-named-access-" });
    const check = yield* safariPermissionCheck.pipe(
      Effect.provideService(HostProcessEnvironment, { HOME: home }),
      Effect.provideService(HostProcessPlatform, "darwin"),
    );
    assert.isFalse(yield* Effect.promise(check));
    const directory = `${home}/Library/Containers/com.apple.Safari/Data/Library/WebKit/WebsiteDataStore/12345678-1234-1234-1234-123456789abc/Cookies`;
    yield* fs.makeDirectory(directory, { recursive: true });
    yield* fs.writeFileString(`${directory}/Cookies.binarycookies`, "not parsed");
    assert.isTrue(yield* Effect.promise(check));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
