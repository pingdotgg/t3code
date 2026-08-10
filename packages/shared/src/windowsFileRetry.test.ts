import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";

import { retryWindowsFileSystemOperation } from "./windowsFileRetry.ts";

const failure = (tag: PlatformError.SystemErrorTag, cause?: unknown) =>
  PlatformError.systemError({
    _tag: tag,
    module: "FileSystem",
    method: "rename",
    pathOrDescriptor: "C:\\state\\settings.json",
    ...(cause === undefined ? {} : { cause }),
  });

describe("retryWindowsFileSystemOperation", () => {
  it.effect("retries transient Windows sharing failures", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const operation = Effect.suspend(() => {
        attempts += 1;
        return attempts < 3 ? Effect.fail(failure("Busy")) : Effect.succeed("ok");
      });

      const result = yield* retryWindowsFileSystemOperation(operation, {
        platform: "win32",
        delaysMs: [0, 0, 0],
      });
      assert.equal(result, "ok");
      assert.equal(attempts, 3);
    }),
  );

  it.effect("retries Windows permission-denied replacement races", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const operation = Effect.suspend(() => {
        attempts += 1;
        return attempts < 2 ? Effect.fail(failure("PermissionDenied")) : Effect.succeed(attempts);
      });
      assert.equal(
        yield* retryWindowsFileSystemOperation(operation, {
          platform: "win32",
          delaysMs: [0],
        }),
        2,
      );
    }),
  );

  it.effect("retries an Unknown wrapper when the original Windows errno is transient", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const cause = Object.assign(new Error("sharing violation"), { code: "EPERM" });
      const operation = Effect.suspend(() => {
        attempts += 1;
        return attempts < 2 ? Effect.fail(failure("Unknown", cause)) : Effect.succeed(true);
      });
      assert.isTrue(
        yield* retryWindowsFileSystemOperation(operation, {
          platform: "win32",
          delaysMs: [0],
        }),
      );
      assert.equal(attempts, 2);
    }),
  );

  it.effect("does not retry permanent failures", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const permanent = failure("NotFound");
      const error = yield* retryWindowsFileSystemOperation(
        Effect.suspend(() => {
          attempts += 1;
          return Effect.fail(permanent);
        }),
        { platform: "win32", delaysMs: [0, 0] },
      ).pipe(Effect.flip);
      assert.strictEqual(error, permanent);
      assert.equal(attempts, 1);
    }),
  );

  it.effect("does not apply Windows retries on other platforms", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const transient = failure("Busy");
      const error = yield* retryWindowsFileSystemOperation(
        Effect.suspend(() => {
          attempts += 1;
          return Effect.fail(transient);
        }),
        { platform: "linux", delaysMs: [0, 0] },
      ).pipe(Effect.flip);
      assert.strictEqual(error, transient);
      assert.equal(attempts, 1);
    }),
  );
});
