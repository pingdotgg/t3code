import { OrchestrationGetSnapshotError, type OrchestrationThread } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";

import { threadAllows, threadIsGone } from "./threads.ts";

const externalPiThread = {
  backing: {
    kind: "external",
    source: "pi",
    sourceKey: "source",
    control: "readOnly",
    capabilities: {
      send: false,
      attachments: false,
      streamingBehaviors: [],
      interrupt: false,
      stop: false,
      rename: false,
      archive: false,
      settle: true,
      unsettle: true,
      delete: false,
      changeModel: false,
      changeRuntimeMode: false,
      changeInteractionMode: false,
      checkpoints: false,
    },
  },
} as Pick<OrchestrationThread, "backing">;

describe("threadAllows", () => {
  it("allows explicit Pi settlement without enabling generic lifecycle actions", () => {
    expect(threadAllows(externalPiThread, "settle")).toBe(true);
    expect(threadAllows(externalPiThread, "unsettle")).toBe(true);
    expect(threadAllows(externalPiThread, "lifecycle")).toBe(false);
  });
});

const snapshotFailure = (code?: string) =>
  Cause.fail(
    new OrchestrationGetSnapshotError({
      message: "Failed to subscribe to external thread",
      ...(code === undefined ? {} : { code }),
    }),
  );

describe("threadIsGone", () => {
  it("recognizes a thread the server no longer knows about", () => {
    expect(threadIsGone(snapshotFailure("thread_not_found"))).toBe(true);
    expect(threadIsGone(snapshotFailure("thread_unscoped"))).toBe(true);
  });

  it("keeps transient failures on the fast retry", () => {
    expect(threadIsGone(snapshotFailure("lifecycle_store"))).toBe(false);
    expect(threadIsGone(snapshotFailure())).toBe(false);
    expect(threadIsGone(Cause.die(new Error("boom")))).toBe(false);
    expect(
      threadIsGone(
        Cause.fromReasons([
          ...snapshotFailure("thread_not_found").reasons,
          ...snapshotFailure("internal").reasons,
        ]),
      ),
    ).toBe(false);
  });
});
