// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeStream from "node:stream";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";
import * as HostProcess from "@t3tools/shared/HostProcess";

import {
  BootstrapEnvelopeDecodeError,
  BootstrapEnvelopeMissingError,
  BootstrapEnvelopeReadError,
  BootstrapEnvelopeTimeoutError,
  BootstrapFdStatError,
  BootstrapInputStreamOpenError,
  readBootstrapEnvelope,
} from "./bootstrap.ts";

const openSyncInterceptor = vi.hoisted(() => ({
  failPath: null as string | null,
  errorCode: "ENXIO",
}));
const fstatSyncInterceptor = vi.hoisted(() => ({ failFd: null as number | null }));
const readStreamInterceptor = vi.hoisted(() => ({ stream: null as NodeStream.Readable | null }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    createReadStream: (...args: Parameters<typeof actual.createReadStream>) =>
      readStreamInterceptor.stream ?? actual.createReadStream(...args),
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const [filePath, flags] = args;
      if (
        typeof filePath === "string" &&
        filePath === openSyncInterceptor.failPath &&
        flags === "r"
      ) {
        const error = new Error(`open failed with ${openSyncInterceptor.errorCode}`);
        Object.assign(error, { code: openSyncInterceptor.errorCode });
        throw error;
      }
      return (actual.openSync as (...a: typeof args) => number)(...args);
    },
    fstatSync: (...args: Parameters<typeof actual.fstatSync>) => {
      if (args[0] === fstatSyncInterceptor.failFd) {
        const error = new Error("permission denied");
        Object.assign(error, { code: "EACCES" });
        throw error;
      }
      return (actual.fstatSync as (...a: typeof args) => NodeFS.Stats)(...args);
    },
  };
});

const windowsHost = HostProcess.Platform.defaultValue() === "win32";
const nullDevice = windowsHost ? "\\\\.\\NUL" : "/dev/null";
const closeIfOpen = (fd: number) => {
  try {
    NodeFS.closeSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EBADF") throw error;
  }
};

// A successful Windows read streams the inherited fd with autoClose. POSIX
// reopens the fd through /proc or /dev, so the test still owns the original.
const openBootstrapInputFd = (filePath: string) =>
  Effect.acquireRelease(
    Effect.sync(() => NodeFS.openSync(filePath, "r")),
    (fd) => (windowsHost ? Effect.void : Effect.sync(() => closeIfOpen(fd))),
  );

const TestEnvelopeSchema = Schema.Struct({ mode: Schema.String });
const encodeTestEnvelopeSchema = Schema.encodeEffect(Schema.fromJsonString(TestEnvelopeSchema));

// Control pipe delivery independently of the virtual timeout, on every host.
const openControlledBootstrapInput = Effect.acquireRelease(
  Effect.sync(() => {
    const fd = NodeFS.openSync(nullDevice, "r");
    const stream = new NodeStream.PassThrough();
    const reading = Deferred.makeUnsafe<void>();
    stream.once("resume", () => Deferred.doneUnsafe(reading, Effect.void));
    readStreamInterceptor.stream = stream;
    return { fd, stream, reading };
  }),
  ({ fd, stream }) =>
    Effect.sync(() => {
      readStreamInterceptor.stream = null;
      stream.destroy();
      closeIfOpen(fd);
    }),
);

it.layer(NodeServices.layer)("readBootstrapEnvelope", (it) => {
  it.effect("reads a bootstrap envelope from a provided fd", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const filePath = yield* fs.makeTempFileScoped({ prefix: "t3-bootstrap-", suffix: ".ndjson" });

      yield* fs.writeFileString(
        filePath,
        `${yield* encodeTestEnvelopeSchema({ mode: "desktop" })}\n`,
      );

      const fd = yield* openBootstrapInputFd(filePath);

      const payload = yield* readBootstrapEnvelope(TestEnvelopeSchema, fd, { timeoutMs: 100 });
      assert.deepEqual(payload, {
        mode: "desktop",
      });
    }),
  );

  it.effect("falls back to reading the inherited fd when path duplication fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const filePath = yield* fs.makeTempFileScoped({ prefix: "t3-bootstrap-", suffix: ".ndjson" });

      yield* fs.writeFileString(
        filePath,
        `${yield* encodeTestEnvelopeSchema({ mode: "desktop" })}\n`,
      );

      // Open without acquireRelease: the direct-stream fallback uses autoClose: true,
      // so the stream owns the fd lifecycle and closes it asynchronously on end.
      // Attempting to also close it synchronously in a finalizer races with the
      // stream's async close and produces an uncaught EBADF.
      const fd = NodeFS.openSync(filePath, "r");

      openSyncInterceptor.failPath = `/proc/self/fd/${fd}`;
      try {
        const payload = yield* readBootstrapEnvelope(TestEnvelopeSchema, fd, {
          timeoutMs: 100,
        }).pipe(Effect.provideService(HostProcess.Platform, "linux"));
        assert.deepEqual(payload, {
          mode: "desktop",
        });
      } finally {
        openSyncInterceptor.failPath = null;
      }
    }),
  );

  it.effect("preserves fd path, platform, and cause when opening the input stream fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const filePath = yield* fs.makeTempFileScoped({ prefix: "t3-bootstrap-", suffix: ".ndjson" });
      const fd = yield* Effect.acquireRelease(
        Effect.sync(() => NodeFS.openSync(filePath, "r")),
        (fd) => Effect.sync(() => closeIfOpen(fd)),
      );
      const fdPath = `/proc/self/fd/${fd}`;

      openSyncInterceptor.failPath = fdPath;
      openSyncInterceptor.errorCode = "EIO";
      try {
        const error = yield* readBootstrapEnvelope(TestEnvelopeSchema, fd, {
          timeoutMs: 100,
        }).pipe(Effect.provideService(HostProcess.Platform, "linux"), Effect.flip);

        assert.instanceOf(error, BootstrapInputStreamOpenError);
        assert.equal(error.fd, fd);
        assert.equal(error.platform, "linux");
        assert.equal(error.fdPath, fdPath);
        assert.equal((error.cause as NodeJS.ErrnoException).code, "EIO");
        assert.equal(
          error.message,
          `Failed to open bootstrap input stream for file descriptor ${fd} via '${fdPath}' on 'linux'.`,
        );
      } finally {
        openSyncInterceptor.failPath = null;
        openSyncInterceptor.errorCode = "ENXIO";
      }
    }),
  );

  it.effect("fails when the explicitly provided fd is unavailable", () =>
    Effect.gen(function* () {
      const fd = NodeFS.openSync(nullDevice, "r");
      NodeFS.closeSync(fd);

      const error = yield* readBootstrapEnvelope(TestEnvelopeSchema, fd, {
        timeoutMs: 100,
      }).pipe(Effect.flip);
      assert.instanceOf(error, BootstrapFdStatError);
      assert.equal(error.fd, fd);
    }),
  );

  it.effect("preserves fd and cause when stat fails for a non-availability reason", () =>
    Effect.gen(function* () {
      const fd = yield* Effect.acquireRelease(
        Effect.sync(() => NodeFS.openSync(nullDevice, "r")),
        (fd) => Effect.sync(() => closeIfOpen(fd)),
      );

      fstatSyncInterceptor.failFd = fd;
      try {
        const error = yield* readBootstrapEnvelope(TestEnvelopeSchema, fd, {
          timeoutMs: 100,
        }).pipe(Effect.flip);

        assert.instanceOf(error, BootstrapFdStatError);
        assert.equal(error.fd, fd);
        assert.equal((error.cause as NodeJS.ErrnoException).code, "EACCES");
        assert.equal(error.message, `Failed to stat bootstrap file descriptor ${fd}.`);
      } finally {
        fstatSyncInterceptor.failFd = null;
      }
    }),
  );

  it.effect("preserves fd and schema cause when decoding the envelope fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const filePath = yield* fs.makeTempFileScoped({ prefix: "t3-bootstrap-", suffix: ".ndjson" });
      yield* fs.writeFileString(filePath, '{"mode":42}\n');

      const fd = yield* openBootstrapInputFd(filePath);
      const error = yield* readBootstrapEnvelope(TestEnvelopeSchema, fd, {
        timeoutMs: 100,
      }).pipe(Effect.flip);

      assert.instanceOf(error, BootstrapEnvelopeDecodeError);
      assert.equal(error.fd, fd);
      assert.isDefined(error.cause);
      assert.equal(
        error.message,
        `Failed to decode bootstrap envelope from file descriptor ${fd}.`,
      );
    }),
  );

  it.effect("accepts an envelope arriving after the former one-second deadline", () =>
    Effect.gen(function* () {
      const { fd, stream, reading } = yield* openControlledBootstrapInput;
      const fiber = yield* readBootstrapEnvelope(TestEnvelopeSchema, fd).pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.forkScoped,
      );

      yield* Deferred.await(reading);
      yield* TestClock.adjust(1_001);
      stream.end('{"mode":"desktop"}\n');

      const payload = yield* Fiber.join(fiber);
      assert.deepEqual(payload, { mode: "desktop" });
      assert.isTrue(stream.destroyed);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("fails at the default deadline and releases the pending reader", () =>
    Effect.gen(function* () {
      const { fd, stream, reading } = yield* openControlledBootstrapInput;
      const fiber = yield* readBootstrapEnvelope(TestEnvelopeSchema, fd).pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.flip,
        Effect.forkScoped,
      );

      yield* Deferred.await(reading);
      yield* TestClock.adjust(30_000);

      const error = yield* Fiber.join(fiber);
      assert.instanceOf(error, BootstrapEnvelopeTimeoutError);
      assert.equal(error.fd, fd);
      assert.equal(error.timeoutMs, 30_000);
      assert.isTrue(stream.destroyed);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("fails when the pipe closes without an envelope", () =>
    Effect.gen(function* () {
      const { fd, stream, reading } = yield* openControlledBootstrapInput;
      const fiber = yield* readBootstrapEnvelope(TestEnvelopeSchema, fd).pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.flip,
        Effect.forkScoped,
      );

      yield* Deferred.await(reading);
      stream.end();

      const error = yield* Fiber.join(fiber);
      assert.instanceOf(error, BootstrapEnvelopeMissingError);
      assert.equal(error.fd, fd);
      assert.isTrue(stream.destroyed);
    }),
  );

  it.effect("preserves read errors instead of treating an unavailable pipe as optional", () =>
    Effect.gen(function* () {
      const { fd, stream, reading } = yield* openControlledBootstrapInput;
      const cause = Object.assign(new Error("closed fd"), { code: "EBADF" });
      const fiber = yield* readBootstrapEnvelope(TestEnvelopeSchema, fd).pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.flip,
        Effect.forkScoped,
      );

      yield* Deferred.await(reading);
      stream.destroy(cause);

      const error = yield* Fiber.join(fiber);
      assert.instanceOf(error, BootstrapEnvelopeReadError);
      assert.equal(error.fd, fd);
      assert.equal(error.cause, cause);
      assert.isTrue(stream.destroyed);
    }),
  );
});
