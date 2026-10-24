import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopOwnerIdentity from "./DesktopOwnerIdentity.ts";

const STATE_DIR = "/tmp/t3-owner-identity";

const layerEnvironment = Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
  baseDir: "/tmp/t3-owner-identity-home",
  stateDir: STATE_DIR,
  path: { join: (...segments: ReadonlyArray<string>) => segments.join("/") },
} as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);

/**
 * A file system that fails the way a real one would, and counts the reads so
 * a test can see how often the identity is looked up.
 */
const layerFailingFileSystem = (options: {
  readonly readFails?: boolean;
  readonly writeFails?: boolean;
  readonly reads: Ref.Ref<number>;
}) =>
  Layer.succeed(FileSystem.FileSystem, {
    readFileString: (path: string) =>
      Ref.updateAndGet(options.reads, (count) => count + 1).pipe(
        Effect.flatMap(() =>
          options.readFails
            ? Effect.fail(
                new PlatformError.PlatformError(
                  new PlatformError.SystemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "readFileString",
                    pathOrDescriptor: path,
                  }),
                ),
              )
            : Effect.fail(
                new PlatformError.PlatformError(
                  new PlatformError.SystemError({
                    _tag: "NotFound",
                    module: "FileSystem",
                    method: "readFileString",
                    pathOrDescriptor: path,
                  }),
                ),
              ),
        ),
      ),
    writeFileString: (path: string) =>
      options.writeFails
        ? Effect.fail(
            new PlatformError.PlatformError(
              new PlatformError.SystemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "writeFileString",
                pathOrDescriptor: path,
              }),
            ),
          )
        : Effect.void,
  } as unknown as FileSystem.FileSystem);

describe("DesktopOwnerIdentity", () => {
  it.effect("persists a generated identity", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.makeDirectory(STATE_DIR, { recursive: true });
      yield* fileSystem.remove(`${STATE_DIR}/desktop-owner-id`, { force: true });
      const identity = yield* DesktopOwnerIdentity.make;

      const ownerId = yield* identity.ownerId;

      assert.isTrue(ownerId.trim().length > 0, "the identity must not be empty");
      assert.equal(
        (yield* fileSystem.readFileString(`${STATE_DIR}/desktop-owner-id`)).trim(),
        ownerId,
        "the identity must be on disk",
      );
    }).pipe(Effect.provide(Layer.mergeAll(layerEnvironment, NodeServices.layer))),
  );

  it.effect("reuses the stored identity on the next launch", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.makeDirectory(STATE_DIR, { recursive: true });
      yield* fileSystem.remove(`${STATE_DIR}/desktop-owner-id`, { force: true });

      const first = yield* DesktopOwnerIdentity.make;
      const firstId = yield* first.ownerId;
      const second = yield* DesktopOwnerIdentity.make;
      const secondId = yield* second.ownerId;

      assert.equal(secondId, firstId, "a later launch must recognize its own leftover");
    }).pipe(Effect.provide(Layer.mergeAll(layerEnvironment, NodeServices.layer))),
  );

  it.effect("treats an empty stored identity as absent", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.makeDirectory(STATE_DIR, { recursive: true });
      yield* fileSystem.writeFileString(`${STATE_DIR}/desktop-owner-id`, "  \n");

      const identity = yield* DesktopOwnerIdentity.make;
      const ownerId = yield* identity.ownerId;

      assert.isTrue(ownerId.trim().length > 0, "an empty identity must be replaced");
    }).pipe(Effect.provide(Layer.mergeAll(layerEnvironment, NodeServices.layer))),
  );

  it.effect("does not overwrite the stored identity when the read fails", () =>
    Effect.gen(function* () {
      const reads = yield* Ref.make(0);
      const identity = yield* DesktopOwnerIdentity.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            layerEnvironment,
            layerFailingFileSystem({ readFails: true, reads }),
            NodeCrypto.layer,
          ),
        ),
      );

      const outcome = yield* identity.ownerId.pipe(Effect.result);

      assert.isTrue(outcome._tag === "Failure", "a read failure must not be swallowed");
      assert.equal(yield* Ref.get(reads), 1, "the identity must be read once");
    }),
  );

  it.effect("does not hand out an identity it could not persist", () =>
    Effect.gen(function* () {
      const reads = yield* Ref.make(0);
      const identity = yield* DesktopOwnerIdentity.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            layerEnvironment,
            layerFailingFileSystem({ writeFails: true, reads }),
            NodeCrypto.layer,
          ),
        ),
      );

      const outcome = yield* identity.ownerId.pipe(Effect.result);

      assert.isTrue(
        outcome._tag === "Failure",
        "an identity the desktop could not save must not reach a server",
      );
    }),
  );

  it.effect("gives every consumer in one launch the same identity", () =>
    Effect.gen(function* () {
      const reads = yield* Ref.make(0);
      const identity = yield* DesktopOwnerIdentity.make.pipe(
        Effect.provide(
          Layer.mergeAll(layerEnvironment, layerFailingFileSystem({ reads }), NodeCrypto.layer),
        ),
      );

      // The ownership check and the bootstrap configuration both read the
      // identity, and they have to agree on it. A second read that reached
      // the file would generate a different identity, because the file is
      // still missing.
      const first = yield* identity.ownerId;
      const second = yield* identity.ownerId;

      assert.isTrue(first.trim().length > 0, "the identity must not be empty");
      assert.equal(second, first, "both consumers must see the same identity");
      assert.equal(yield* Ref.get(reads), 1, "the identity must be read once per launch");
    }),
  );
});
