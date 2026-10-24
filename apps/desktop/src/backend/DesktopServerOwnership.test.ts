import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopOwnerIdentity from "./DesktopOwnerIdentity.ts";
import * as DesktopServerOwnership from "./DesktopServerOwnership.ts";

const makeRecord = (overrides?: {
  readonly pid?: number;
  readonly port?: number;
  readonly origin?: string;
  readonly serviceManaged?: boolean;
  readonly desktopOwnerId?: string;
}): Effect.Effect<DesktopServerOwnership.DesktopServerRuntimeRecord> =>
  Effect.sync(() => {
    // The recorded start time has to match the running process, or the
    // desktop treats the pid as recycled and reports no owner at all. The
    // real clock is used here: the test clock starts at the epoch, which
    // every running process started after.
    const now = DateTime.nowUnsafe();
    return {
      version: 1,
      pid: overrides?.pid ?? process.pid,
      port: overrides?.port ?? 3773,
      origin: overrides?.origin ?? "http://127.0.0.1:3773",
      startedAt: DateTime.formatIso(now),
      ...(overrides?.serviceManaged === undefined
        ? {}
        : { serviceManaged: overrides.serviceManaged }),
      ...(overrides?.desktopOwnerId === undefined
        ? {}
        : { desktopOwnerId: overrides.desktopOwnerId }),
    };
  });

interface HarnessOptions {
  readonly record?: Effect.Effect<DesktopServerOwnership.DesktopServerRuntimeRecord> | null;
  /** Writes the record verbatim, so a test can make it unreadable. */
  readonly rawRecord?: string;
  readonly descriptorStatus?: number;
  readonly baseDir: string;
}

const makeHarness = (options: HarnessOptions) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const stateDir = `${options.baseDir}/userdata`;
    const recordPath = `${stateDir}/server-runtime.json`;

    yield* fileSystem.makeDirectory(stateDir, { recursive: true });
    if (options.rawRecord !== undefined) {
      yield* fileSystem.writeFileString(recordPath, options.rawRecord);
    } else if (options.record) {
      const record = yield* options.record;
      yield* fileSystem.writeFileString(recordPath, JSON.stringify(record));
    } else {
      yield* fileSystem.remove(recordPath, { force: true });
    }

    const layerEnvironment = Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
      baseDir: options.baseDir,
      stateDir,
      path: { join: (...segments: ReadonlyArray<string>) => segments.join("/") },
    } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);

    const layerHttpClient = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(null, { status: options.descriptorStatus ?? 200 }),
          ),
        ),
      ),
    );

    const ownerIdentity = yield* DesktopOwnerIdentity.make.pipe(
      Effect.provide(Layer.mergeAll(layerEnvironment, layerHttpClient, NodeServices.layer)),
    );
    const ownership = yield* DesktopServerOwnership.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          layerEnvironment,
          layerHttpClient,
          NodeServices.layer,
          Layer.succeed(DesktopOwnerIdentity.DesktopOwnerIdentity, ownerIdentity),
        ),
      ),
    );

    return { ownership, ownerIdentity, recordPath, stateDir };
  });

describe("DesktopServerOwnership", () => {
  it.effect("reports no owner when the T3 home has no runtime record", () =>
    Effect.gen(function* () {
      const { ownership } = yield* makeHarness({ baseDir: "/tmp/t3-ownership-empty" });
      const owner = yield* ownership.inspect;
      assert.equal(owner._tag, "none");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports no owner when the recorded server is gone", () =>
    Effect.gen(function* () {
      // A pid that is not running: the lock went with it, so the home is free.
      const { ownership } = yield* makeHarness({
        baseDir: "/tmp/t3-ownership-dead",
        record: makeRecord({ pid: 2 ** 22 }),
      });
      const owner = yield* ownership.inspect;
      assert.equal(owner._tag, "none");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a healthy server that answers its environment descriptor", () =>
    Effect.gen(function* () {
      const { ownership } = yield* makeHarness({
        baseDir: "/tmp/t3-ownership-healthy",
        record: makeRecord(),
        descriptorStatus: 200,
      });
      const owner = yield* ownership.inspect;
      assert.equal(owner._tag, "healthy");
      if (owner._tag === "healthy") {
        assert.equal(owner.httpBaseUrl.href, "http://127.0.0.1:3773/");
        assert.equal(owner.record.pid, process.pid);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a stranded server this desktop started", () =>
    Effect.gen(function* () {
      const { ownerIdentity } = yield* makeHarness({
        baseDir: "/tmp/t3-ownership-stranded",
      });
      const ownerId = yield* ownerIdentity.ownerId;
      const { ownership: ownershipWithMarker } = yield* makeHarness({
        baseDir: "/tmp/t3-ownership-stranded",
        record: makeRecord({ desktopOwnerId: ownerId }),
        descriptorStatus: 503,
      });
      const owner = yield* ownershipWithMarker.inspect;
      assert.equal(owner._tag, "stranded");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves a server this desktop did not start alone", () =>
    Effect.gen(function* () {
      // A server the user started by hand carries no desktop owner id, so
      // the desktop must never recover it.
      const { ownership } = yield* makeHarness({
        baseDir: "/tmp/t3-ownership-foreign",
        record: makeRecord(),
        descriptorStatus: 503,
      });
      const owner = yield* ownership.inspect;
      assert.equal(owner._tag, "foreign");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves a server another desktop started alone", () =>
    Effect.gen(function* () {
      const { ownerIdentity } = yield* makeHarness({
        baseDir: "/tmp/t3-ownership-other-desktop",
      });
      const ownerId = yield* ownerIdentity.ownerId;
      const { ownership: ownershipWithMarker } = yield* makeHarness({
        baseDir: "/tmp/t3-ownership-other-desktop",
        record: makeRecord({ desktopOwnerId: `${ownerId}-other` }),
        descriptorStatus: 503,
      });
      const owner = yield* ownershipWithMarker.inspect;
      assert.equal(owner._tag, "foreign");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves a service-managed server alone even when it does not answer", () =>
    Effect.gen(function* () {
      const { ownership } = yield* makeHarness({
        baseDir: "/tmp/t3-ownership-service",
        record: makeRecord({ serviceManaged: true }),
        descriptorStatus: 503,
      });
      const owner = yield* ownership.inspect;
      assert.equal(owner._tag, "foreign");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("cannot establish the owner when the record cannot be read", () =>
    Effect.gen(function* () {
      // A record the desktop cannot read is not evidence that the home is
      // free, so the desktop establishes nothing and starts nothing.
      const { ownership } = yield* makeHarness({
        baseDir: "/tmp/t3-ownership-unreadable",
        rawRecord: "{ this is not a runtime record",
      });
      const owner = yield* ownership.inspect;
      assert.equal(owner._tag, "unknown");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("cannot establish the owner when the record is empty", () =>
    Effect.gen(function* () {
      const { ownership } = yield* makeHarness({
        baseDir: "/tmp/t3-ownership-empty-record",
        rawRecord: "   \n",
      });
      const owner = yield* ownership.inspect;
      assert.equal(owner._tag, "unknown");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("never hands out an empty owner id", () =>
    Effect.gen(function* () {
      const { ownerIdentity } = yield* makeHarness({ baseDir: "/tmp/t3-ownership-non-empty" });
      const ownerId = yield* ownerIdentity.ownerId;
      assert.isTrue(
        ownerId.trim().length > 0,
        "an empty id would be rejected by the bootstrap contract and would name no owner",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("treats a stored empty owner id as absent", () =>
    Effect.gen(function* () {
      const { ownerIdentity, stateDir } = yield* makeHarness({
        baseDir: "/tmp/t3-ownership-empty-id",
      });
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.writeFileString(`${stateDir}/desktop-owner-id`, "  \n");
      const ownerId = yield* ownerIdentity.ownerId;
      assert.isTrue(ownerId.trim().length > 0, "a stored empty id must be replaced, not accepted");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps the same owner id across launches", () =>
    Effect.gen(function* () {
      const { ownerIdentity } = yield* makeHarness({ baseDir: "/tmp/t3-ownership-owner-id" });
      const first = yield* ownerIdentity.ownerId;
      const { ownerIdentity: secondOwnerIdentity } = yield* makeHarness({
        baseDir: "/tmp/t3-ownership-owner-id",
      });
      const second = yield* secondOwnerIdentity.ownerId;
      assert.equal(first, second, "a later launch must recognize its own leftover");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reads the runtime record from the T3 home's state directory", () =>
    Effect.gen(function* () {
      const { ownership, recordPath } = yield* makeHarness({
        baseDir: "/tmp/t3-ownership-path",
      });
      assert.equal(yield* ownership.runtimeStatePath, recordPath);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
