import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { describe, expect, it } from "vite-plus/test";

import { decideStoredDraftReuse } from "./useHandleNewThread.logic";

const storedDraftThreadRef = scopeThreadRef(
  EnvironmentId.make("environment-1"),
  ThreadId.make("thread-1"),
);

describe("decideStoredDraftReuse", () => {
  it("mints a new draft when the stored id is still a live shell", () => {
    expect(
      decideStoredDraftReuse({
        storedDraftThreadRef,
        liveShellExists: true,
        archivedShellExists: false,
        promoted: false,
      }),
    ).toBe("mint");
  });

  it("mints a new draft when the stored id is only in archived shells", () => {
    expect(
      decideStoredDraftReuse({
        storedDraftThreadRef,
        liveShellExists: false,
        archivedShellExists: true,
        promoted: false,
      }),
    ).toBe("mint");
  });

  it("reuses an empty draft when the stored id is unknown and not promoted", () => {
    expect(
      decideStoredDraftReuse({
        storedDraftThreadRef,
        liveShellExists: false,
        archivedShellExists: false,
        deletedShellExists: false,
        promoted: false,
      }),
    ).toBe("reuse");
  });

  it("mints a new draft when a promoted id is missing from both snapshots", () => {
    expect(
      decideStoredDraftReuse({
        storedDraftThreadRef,
        liveShellExists: false,
        archivedShellExists: null,
        deletedShellExists: null,
        promoted: true,
      }),
    ).toBe("mint");
  });

  it("mints a new draft when the stored id is visible as deleted", () => {
    expect(
      decideStoredDraftReuse({
        storedDraftThreadRef,
        liveShellExists: false,
        archivedShellExists: false,
        deletedShellExists: true,
        promoted: false,
      }),
    ).toBe("mint");
  });

  it("reuses an unpromoted draft when the archived snapshot is not loaded", () => {
    expect(
      decideStoredDraftReuse({
        storedDraftThreadRef,
        liveShellExists: false,
        archivedShellExists: null,
        promoted: false,
      }),
    ).toBe("reuse");
  });

  it("mints a new draft when there is no stored draft to reuse", () => {
    expect(
      decideStoredDraftReuse({
        storedDraftThreadRef: null,
        liveShellExists: false,
        archivedShellExists: null,
        promoted: false,
      }),
    ).toBe("mint");
  });
});
