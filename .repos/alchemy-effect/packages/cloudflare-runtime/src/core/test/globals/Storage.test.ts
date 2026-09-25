import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as Predicate from "effect/Predicate";
import * as NodePath from "node:path";
import * as Storage from "../../globals/Storage.ts";
import { makeTempDirectory } from "../helpers/runtime.ts";

const services = NodeServices.layer;

describe("globals/Storage", () => {
  it.effect("layerDisk creates the directory if it does not exist", () =>
    Effect.gen(function* () {
      const tmp = yield* makeTempDirectory();
      const dir = NodePath.join(tmp, "nested", "storage");
      const storage = yield* Storage.Storage.pipe(
        Effect.provide(Storage.layerDisk(dir).pipe(Layer.provide(services))),
      );
      expect(storage).toMatchObject({
        name: "storage",
        disk: { path: dir, writable: true, allowDotfiles: true },
      });
      expect(NodeFs.existsSync(dir)).toBe(true);
    }).pipe(Effect.provide(services), Effect.scoped),
  );

  it.effect(
    "layerTemp creates a temp directory and cleans it up on scope close",
    () =>
      Effect.gen(function* () {
        const createdPath = yield* Effect.gen(function* () {
          const storage = yield* Storage.Storage;
          assert(Predicate.hasProperty(storage, "disk"));
          assert(Predicate.hasProperty(storage.disk, "path"));
          assert(Predicate.isString(storage.disk.path));
          const tempPath = storage.disk.path;
          expect(tempPath.startsWith(NodeOs.tmpdir())).toBe(true);
          expect(NodeFs.existsSync(tempPath)).toBe(true);
          return tempPath;
        }).pipe(Effect.provide(Storage.layerTemp()), Effect.scoped);
        expect(createdPath).toBeDefined();
        expect(NodeFs.existsSync(createdPath)).toBe(false);
      }).pipe(Effect.provide(services)),
  );
});
