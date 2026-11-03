import { expect, it, vi } from "vite-plus/test";

import { getRenderablePatch } from "~/lib/diffRendering";
import { parsePatchOffMainThread } from "./parsePatchOffMainThread";

const PATCH = [
  "diff --git a/a.ts b/a.ts",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1,2 +1,2 @@",
  " keep",
  "-old",
  "+new",
  "diff --git a/b.ts b/b.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/b.ts",
  "@@ -0,0 +1 @@",
  "+added",
  "",
].join("\n");

// These run first: the module keeps a working worker, and browser mode cannot reset modules.
it.each([
  {
    name: "the worker cannot be created",
    FailingWorker: function () {
      throw new Error("blocked");
    },
  },
  {
    name: "posting to the worker throws",
    FailingWorker: class extends EventTarget {
      postMessage() {
        throw new Error("could not post");
      }
      terminate() {}
    },
  },
  {
    name: "the worker reports an error",
    FailingWorker: class extends EventTarget {
      postMessage() {
        queueMicrotask(() => this.dispatchEvent(new Event("error")));
      }
      terminate() {}
    },
  },
])("parses on the main thread when $name", async ({ FailingWorker }) => {
  vi.stubGlobal("Worker", FailingWorker);
  try {
    await expect(
      Promise.all([
        parsePatchOffMainThread(PATCH, "fallback"),
        parsePatchOffMainThread(PATCH, "fallback"),
      ]),
    ).resolves.toEqual(
      Array(2).fill(getRenderablePatch(PATCH, "fallback", { compactPartialHunkOffsets: true })),
    );
  } finally {
    vi.unstubAllGlobals();
  }
});

it("parses in the worker exactly as on the main thread", async () => {
  const NativeWorker = globalThis.Worker;
  let workerReplies = 0;
  vi.stubGlobal(
    "Worker",
    class extends NativeWorker {
      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args);
        this.addEventListener("message", () => workerReplies++);
      }
    },
  );
  try {
    const [first, second] = await Promise.all([
      parsePatchOffMainThread(PATCH, "test"),
      parsePatchOffMainThread("", "test"),
    ]);

    // The fallback returns the same values, so equal output alone would not prove the worker ran.
    expect(workerReplies).toBe(2);
    expect(first).toEqual(getRenderablePatch(PATCH, "test", { compactPartialHunkOffsets: true }));
    expect(second).toBeNull();
  } finally {
    vi.unstubAllGlobals();
  }
});
