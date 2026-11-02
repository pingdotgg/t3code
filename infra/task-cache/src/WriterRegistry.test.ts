import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as WriterRegistry from "./WriterRegistry.ts";
import { WriterSecrets } from "./deploymentConfig.ts";

const readKeys = Config.Redacted("DEVELOPER_KEYS").pipe(Effect.provide(WriterSecrets));

it.effect("loads the private writer registry as deployment configuration", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped();
    yield* fs.makeDirectory(`${home}/.config/t3-task-cache`, { recursive: true });
    yield* fs.writeFileString(`${home}/.config/t3-task-cache/writers.json`, '{"maria":"digest"}');
    yield* fs.writeFileString(
      `${home}/.config/t3-task-cache/readers.json`,
      '{"ci-reader":"digest"}',
    );
    const keys = yield* readKeys.pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: home }))),
    );
    expect(JSON.parse(Redacted.value(keys))).toEqual({ maria: "digest" });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("uses explicit deployment credentials without requiring a local registry", () =>
  Effect.gen(function* () {
    const keys = yield* readKeys.pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ DEVELOPER_KEYS: '{"theo":"digest"}', READER_KEYS: "{}" }),
        ),
      ),
    );
    expect(JSON.parse(Redacted.value(keys))).toEqual({ theo: "digest" });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("fails instead of deploying an empty registry when credentials are missing", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped();
    const result = yield* readKeys.pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: home }))),
      Effect.exit,
    );
    expect(Exit.isFailure(result)).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("rejects reserved writer names without modifying credential stores", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const home = yield* fs.makeTempDirectoryScoped();
    const state = `${home}/.config/t3-task-cache`;
    yield* fs.makeDirectory(state, { recursive: true });
    const writers = '{"maria":"digest"}';
    const credentials = '{"https://cache.example":{"name":"maria","token":"secret"}}';
    yield* fs.writeFileString(`${state}/writers.json`, writers);
    yield* fs.writeFileString(`${state}/credentials.json`, credentials);
    for (const name of ["writers", "credentials", "readers", "ci-reader"]) {
      const code = yield* spawner.exitCode(
        ChildProcess.make(
          "node",
          [`${import.meta.dirname}/../scripts/manage.ts`, "add-writer", name],
          {
            env: { HOME: home },
            extendEnv: true,
            stdout: "ignore",
            stderr: "ignore",
          },
        ),
      );
      expect(code).not.toBe(0);
      expect(yield* fs.readFileString(`${state}/writers.json`)).toBe(writers);
      expect(yield* fs.readFileString(`${state}/credentials.json`)).toBe(credentials);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("writes credentials for the supplied deployed worker endpoint", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped();
    const endpoint = "https://preview-cache.example/projects/t3code";
    const file = yield* WriterRegistry.WriterRegistry.pipe(
      Effect.flatMap((registry) => registry.update("maria", false, endpoint, true)),
      Effect.provide(
        WriterRegistry.layer.pipe(
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: home }))),
        ),
      ),
    );
    expect(file).toBe(`${home}/.config/t3-task-cache/maria.json`);
    if (!file) return yield* Effect.die("Expected a credential file");
    const credential = JSON.parse(yield* fs.readFileString(file));
    expect(credential.endpoint).toBe(endpoint);
    expect(credential.name).toBe("maria");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("refuses a concurrent registry update without changing committed credentials", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped();
    const state = `${home}/.config/t3-task-cache`;
    yield* fs.makeDirectory(`${state}/writers.lock`, { recursive: true });
    yield* fs.writeFileString(`${state}/writers.json`, '{"maria":"digest"}');
    const result = yield* WriterRegistry.WriterRegistry.pipe(
      Effect.flatMap((registry) => registry.update("theo", false, "https://cache.example")),
      Effect.provide(
        WriterRegistry.layer.pipe(
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: home }))),
        ),
      ),
      Effect.exit,
    );
    expect(Exit.isFailure(result)).toBe(true);
    expect(yield* fs.readFileString(`${state}/writers.json`)).toBe('{"maria":"digest"}');
    expect(yield* fs.exists(`${state}/theo.json`)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("keeps the committed registry intact if a replacement write fails", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped();
    const state = `${home}/.config/t3-task-cache`;
    yield* fs.makeDirectory(state, { recursive: true });
    const original = '{"maria":"digest"}';
    yield* fs.writeFileString(`${state}/writers.json`, original);
    const result = yield* WriterRegistry.WriterRegistry.pipe(
      Effect.flatMap((registry) => registry.update("theo", false, "https://cache.example")),
      Effect.provide(
        WriterRegistry.layer.pipe(
          Layer.provide([
            ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: home })),
            Layer.succeed(FileSystem.FileSystem, {
              ...fs,
              writeFileString: (path) =>
                fs
                  .writeFileString(path, "partial")
                  .pipe(Effect.andThen(Effect.die("disk write failed"))),
            }),
          ]),
        ),
      ),
      Effect.exit,
    );
    expect(Exit.isFailure(result)).toBe(true);
    expect(yield* fs.readFileString(`${state}/writers.json`)).toBe(original);
    expect(yield* fs.exists(`${state}/writers.lock`)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("preserves filesystem errors when acquiring the registry lock", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped();
    const denied = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "makeDirectory",
    });
    const error = yield* WriterRegistry.WriterRegistry.pipe(
      Effect.flatMap((registry) => registry.update("theo", false, "https://cache.example")),
      Effect.provide(
        WriterRegistry.layer.pipe(
          Layer.provide([
            ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: home })),
            Layer.succeed(FileSystem.FileSystem, {
              ...fs,
              makeDirectory: (path, options) =>
                path.endsWith("writers.lock")
                  ? Effect.fail(denied)
                  : fs.makeDirectory(path, options),
            }),
          ]),
        ),
      ),
      Effect.flip,
    );
    expect(error).toBe(denied);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("refuses to initialize a missing writer registry implicitly", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped();
    const result = yield* WriterRegistry.WriterRegistry.pipe(
      Effect.flatMap((registry) => registry.update("theo", false, "https://cache.example")),
      Effect.provide(
        WriterRegistry.layer.pipe(
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: home }))),
        ),
      ),
      Effect.exit,
    );
    expect(Exit.isFailure(result)).toBe(true);
    expect(yield* fs.exists(`${home}/.config/t3-task-cache/writers.json`)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("keeps existing authorization if credential publication fails", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped();
    const state = `${home}/.config/t3-task-cache`;
    yield* fs.makeDirectory(state, { recursive: true });
    const original = '{"maria":"old-digest"}';
    yield* fs.writeFileString(`${state}/writers.json`, original);
    const error = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "rename",
    });
    const result = yield* WriterRegistry.WriterRegistry.pipe(
      Effect.flatMap((registry) => registry.update("maria", false, "https://cache.example")),
      Effect.provide(
        WriterRegistry.layer.pipe(
          Layer.provide([
            ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: home })),
            Layer.succeed(FileSystem.FileSystem, {
              ...fs,
              rename: (from, to) =>
                to === `${state}/maria.json` ? Effect.fail(error) : fs.rename(from, to),
            }),
          ]),
        ),
      ),
      Effect.exit,
    );
    expect(Exit.isFailure(result)).toBe(true);
    expect(yield* fs.readFileString(`${state}/writers.json`)).toBe(original);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
