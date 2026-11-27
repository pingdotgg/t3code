import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import { vi } from "vite-plus/test";

import { removeTestDirectory } from "./config.ts";

// The failure CI saw: a fixture was still writing when the scope removed its directory.
const directoryInUse = PlatformError.systemError({
  _tag: "Unknown",
  module: "FileSystem",
  method: "remove",
  pathOrDescriptor: "/tmp/t3-config-test",
  description: "ENOTEMPTY: directory not empty",
});

it.live("removes a test directory that the first attempt cannot", () => {
  let attempts = 0;
  const remove = vi.fn(() =>
    Effect.suspend(() => {
      attempts += 1;
      return attempts < 3 ? Effect.fail(directoryInUse) : Effect.void;
    }),
  );

  return removeTestDirectory(remove()).pipe(
    Effect.tap(() => Effect.sync(() => assert.equal(attempts, 3))),
  );
});

it.live("stops after the last attempt and leaves the suite passing", () => {
  let attempts = 0;
  const remove = vi.fn(() =>
    Effect.suspend(() => {
      attempts += 1;
      return Effect.fail(directoryInUse);
    }),
  );

  return removeTestDirectory(remove()).pipe(
    Effect.tap(() => Effect.sync(() => assert.equal(attempts, 20))),
  );
});
