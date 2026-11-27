// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { expect, vi } from "vite-plus/test";

import { makeAsyncRotatingFileSink, RotatingFileSink, RotatingFileSinkError } from "./logging.ts";

vi.mock("node:fs", { spy: true });
const { renameSync } = await vi.importActual<typeof NodeFS>("node:fs");
const modes = ["synchronous", "asynchronous"] as const;
const isRotatingFileSinkError = Schema.is(RotatingFileSinkError);

const openSink = Effect.fnUntraced(function* (
  mode: (typeof modes)[number],
  filePath: string,
  maxBytes: number,
  maxFiles: number,
  deny: (source: string, target: string) => boolean = () => false,
) {
  const fs = yield* FileSystem.FileSystem;
  const denied = (source: string) =>
    PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "rename",
      pathOrDescriptor: source,
    });
  if (mode === "synchronous") {
    const spy = vi.mocked(NodeFS.renameSync);
    const run = <A>(action: () => A) => {
      try {
        spy.mockImplementation((source, target) => {
          if (deny(String(source), String(target))) throw denied(String(source));
          renameSync(source, target);
        });
        return action();
      } finally {
        spy.mockReset();
      }
    };
    const sink = run(
      () => new RotatingFileSink({ filePath, maxBytes, maxFiles, throwOnError: true }),
    );
    return {
      write: (chunk: string) =>
        Effect.try({
          try: () => run(() => sink.write(chunk)),
          catch: (cause) =>
            isRotatingFileSinkError(cause)
              ? cause
              : new RotatingFileSinkError({ operation: "write", filePath, cause }),
        }),
    };
  }
  return yield* makeAsyncRotatingFileSink({ filePath, maxBytes, maxFiles }).pipe(
    Effect.provideService(FileSystem.FileSystem, {
      ...fs,
      rename: (source, target) =>
        deny(source, target) ? Effect.fail(denied(source)) : fs.rename(source, target),
    }),
  );
});

effectIt.layer(NodeServices.layer)("log rotation recovery", (it) => {
  it.effect.each(
    modes.flatMap((mode) => [
      { mode, active: false, backup: false },
      { mode, active: true, backup: false },
      { mode, active: true, backup: true },
    ]),
  )(
    "$mode sink recovers staged history with active=$active and backup=$backup",
    ({ mode, active, backup }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped();
        const filePath = path.join(directory, "provider.log");
        yield* fs.writeFileString(`${filePath}.rotating`, "staged");
        if (active) yield* fs.writeFileString(filePath, "active");
        if (backup) yield* fs.writeFileString(`${filePath}.1`, "backup");

        const sink = yield* openSink(mode, filePath, 6, 3);
        yield* sink.write("next");

        expect(yield* fs.exists(`${filePath}.rotating`)).toBe(false);
        expect(yield* fs.readFileString(filePath)).toBe("next");
        expect(yield* fs.readFileString(`${filePath}.1`)).toBe(active ? "active" : "staged");
        if (active) expect(yield* fs.readFileString(`${filePath}.2`)).toBe("staged");
        if (backup) expect(yield* fs.readFileString(`${filePath}.3`)).toBe("backup");
      }),
  );

  it.effect.each(
    modes.flatMap((mode) => (["stage", "publish"] as const).map((phase) => ({ mode, phase }))),
  )(
    "$mode sink preserves every backup when $phase fails and writes after it clears",
    ({ mode, phase }) =>
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
        const sink = yield* openSink(
          mode,
          filePath,
          6,
          2,
          (source, target) =>
            (phase === "stage"
              ? source === filePath
              : source === `${filePath}.rotating` && target === `${filePath}.1`) && denials++ < 2,
        );

        for (const attempt of [1, 2]) {
          const failed = yield* sink.write("next").pipe(Effect.flip);
          expect(failed).toMatchObject({ operation: "rotate" });
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

  it.effect.each(modes)("%s sink restores a numbered backup parked before publication", (mode) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const filePath = path.join(directory, "provider.log");
      yield* fs.writeFileString(`${filePath}.rotating`, "active");
      yield* fs.writeFileString(`${filePath}.1`, "previous");
      yield* fs.writeFileString(`${filePath}.3`, "oldest");

      const sink = yield* openSink(mode, filePath, 9, 2);
      yield* sink.write("ok");
      expect(yield* fs.readFileString(filePath)).toBe("activeok");
      expect(yield* fs.readFileString(`${filePath}.1`)).toBe("previous");
      expect(yield* fs.readFileString(`${filePath}.2`)).toBe("oldest");
      expect(yield* fs.exists(`${filePath}.3`)).toBe(false);
    }),
  );

  it.effect.each(modes)("%s sink retries blocked recovery before writing after reopen", (mode) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const filePath = path.join(directory, "provider.log");
      yield* fs.writeFileString(filePath, "active");
      yield* fs.writeFileString(`${filePath}.1`, "previous");
      yield* fs.writeFileString(`${filePath}.2`, "oldest");
      let locked = true;
      const deny = (source: string, target: string) =>
        locked &&
        target === `${filePath}.1` &&
        (source === `${filePath}.rotating` || source === `${filePath}.2`);
      const sink = yield* openSink(mode, filePath, 9, 2, deny);
      expect(yield* sink.write("next").pipe(Effect.flip)).toMatchObject({ operation: "rotate" });

      const reopened = yield* openSink(mode, filePath, 9, 2, deny);
      expect(yield* reopened.write("ok").pipe(Effect.flip)).toMatchObject({ operation: "rotate" });
      expect(yield* fs.exists(filePath)).toBe(false);
      expect(yield* fs.readFileString(`${filePath}.rotating`)).toBe("active");
      expect(yield* fs.readFileString(`${filePath}.2`)).toBe("previous");
      expect(yield* fs.readFileString(`${filePath}.rotating.oldest`)).toBe("oldest");

      locked = false;
      yield* reopened.write("ok");
      expect(yield* fs.readFileString(filePath)).toBe("activeok");
      expect(yield* fs.readFileString(`${filePath}.1`)).toBe("previous");
      expect(yield* fs.readFileString(`${filePath}.2`)).toBe("oldest");
      expect((yield* fs.readDirectory(directory)).sort()).toEqual([
        "provider.log",
        "provider.log.1",
        "provider.log.2",
      ]);
    }),
  );
});
