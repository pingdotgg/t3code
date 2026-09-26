// @effect-diagnostics nodeBuiltinImport:off - tests fake a failed write at the native v8 boundary.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeV8 from "node:v8";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { vi } from "vite-plus/test";

import { writeHeapSnapshot } from "./HeapSnapshot.ts";

vi.mock("node:v8", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeV8>();
  return { ...actual, writeHeapSnapshot: vi.fn(actual.writeHeapSnapshot) };
});

it.layer(NodeServices.layer)("writeHeapSnapshot", (it) => {
  it.effect("removes the partial file when the write fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const logsDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-heap-snapshot-test-" });
      let partialPath: string | undefined;
      vi.mocked(NodeV8.writeHeapSnapshot).mockImplementationOnce((path) => {
        partialPath = path;
        if (path) NodeFS.writeFileSync(path, "partial");
        throw new Error("ENOSPC: no space left on device");
      });

      yield* writeHeapSnapshot(logsDir);

      assert.strictEqual(NodePath.dirname(partialPath ?? ""), logsDir);
      assert.deepEqual(yield* fs.readDirectory(logsDir), []);
    }),
  );
});
