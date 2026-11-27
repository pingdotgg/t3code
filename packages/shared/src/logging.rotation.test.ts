// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { expect } from "vite-plus/test";

import { makeAsyncRotatingFileSink } from "./logging.ts";

effectIt.layer(NodeServices.layer)("asynchronous log rotation recovery", (it) => {
  it.effect.each([
    { active: false, backup: false },
    { active: true, backup: false },
    { active: true, backup: true },
  ])(
    "recovers staged history on reopen with active=$active and backup=$backup",
    ({ active, backup }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped();
        const filePath = path.join(directory, "provider.log");
        yield* fs.writeFileString(`${filePath}.rotating`, "staged");
        if (active) yield* fs.writeFileString(filePath, "active");
        if (backup) yield* fs.writeFileString(`${filePath}.1`, "backup");

        const sink = yield* makeAsyncRotatingFileSink({ filePath, maxBytes: 6, maxFiles: 3 });
        yield* sink.write("next");

        expect(yield* fs.exists(`${filePath}.rotating`)).toBe(false);
        expect(yield* fs.readFileString(filePath)).toBe("next");
        expect(yield* fs.readFileString(`${filePath}.1`)).toBe(active ? "active" : "staged");
        if (active) expect(yield* fs.readFileString(`${filePath}.2`)).toBe("staged");
        if (backup) expect(yield* fs.readFileString(`${filePath}.3`)).toBe("backup");
      }),
  );

  it.effect.each(["stage", "publish"] as const)(
    "preserves every backup when %s fails and writes after it clears",
    (phase) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped();
        const filePath = path.join(directory, "provider.log");
        const history = [
          [filePath, "active"],
          [`${filePath}.1`, "previous"],
          [`${filePath}.2`, "oldest"],
        ] as const;
        for (const [name, content] of history) yield* fs.writeFileString(name, content);
        let denials = 0;
        const sink = yield* makeAsyncRotatingFileSink({ filePath, maxBytes: 6, maxFiles: 2 }).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            rename: (source, target) =>
              (phase === "stage"
                ? source === filePath
                : target === `${filePath}.1` && source === `${filePath}.rotating`) && denials++ < 2
                ? Effect.fail(
                    PlatformError.systemError({
                      _tag: "PermissionDenied",
                      module: "FileSystem",
                      method: "rename",
                      pathOrDescriptor: source,
                    }),
                  )
                : fs.rename(source, target),
          }),
        );

        for (const attempt of [1, 2]) {
          const failed = yield* sink.write("next").pipe(Effect.flip);
          expect(failed.operation).toBe("rotate");
          expect(denials).toBe(attempt);
          for (const [name, content] of history) {
            expect(yield* fs.readFileString(name)).toBe(content);
          }
        }
        yield* sink.write("next");
        expect(yield* fs.readFileString(filePath)).toBe("next");
        expect(yield* fs.readFileString(`${filePath}.1`)).toBe("active");
        expect(yield* fs.readFileString(`${filePath}.2`)).toBe("previous");
        expect((yield* fs.readDirectory(directory)).sort()).toEqual([
          "provider.log",
          "provider.log.1",
          "provider.log.2",
        ]);
      }),
  );
});
