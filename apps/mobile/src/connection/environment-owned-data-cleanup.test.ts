import { EnvironmentId } from "@t3tools/contracts";
import { Effect, Exit } from "effect";
import { describe, expect, it, vi } from "vitest";

import { clearMobileEnvironmentOwnedData } from "./environment-owned-data-cleanup";

describe("clearMobileEnvironmentOwnedData", () => {
  it("clears both queued messages and composer drafts for a removed environment", async () => {
    const environmentId = EnvironmentId.make("environment-1");
    const clearThreadOutbox = vi.fn(async () => undefined);
    const clearComposerDrafts = vi.fn(async () => undefined);

    await Effect.runPromise(
      clearMobileEnvironmentOwnedData(environmentId, {
        clearThreadOutbox,
        clearComposerDrafts,
      }),
    );

    expect(clearThreadOutbox).toHaveBeenCalledWith(environmentId);
    expect(clearComposerDrafts).toHaveBeenCalledWith(environmentId);
  });

  it.each([
    ["thread-outbox" as const, "outbox"],
    ["composer-drafts" as const, "drafts"],
  ])("reports a structured %s rejection", async (resource, failingOperation) => {
    const environmentId = EnvironmentId.make("environment-1");
    const exit = await Effect.runPromiseExit(
      clearMobileEnvironmentOwnedData(environmentId, {
        clearThreadOutbox: async () => {
          if (failingOperation === "outbox") throw new Error("outbox unavailable");
        },
        clearComposerDrafts: async () => {
          if (failingOperation === "drafts") throw new Error("drafts unavailable");
        },
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(String(exit.cause)).toContain("EnvironmentOwnedDataCleanupError");
      expect(String(exit.cause)).toContain(resource);
    }
  });

  it("reports both simultaneous failures and retries both resources", async () => {
    const environmentId = EnvironmentId.make("environment-1");
    let shouldFail = true;
    const clearThreadOutbox = vi.fn(async () => {
      if (shouldFail) throw new Error("outbox unavailable");
    });
    const clearComposerDrafts = vi.fn(async () => {
      if (shouldFail) throw new Error("drafts unavailable");
    });

    const first = await Effect.runPromiseExit(
      clearMobileEnvironmentOwnedData(environmentId, {
        clearThreadOutbox,
        clearComposerDrafts,
      }),
    );
    expect(Exit.isFailure(first)).toBe(true);
    if (Exit.isFailure(first)) {
      expect(String(first.cause)).toContain("thread-outbox");
      expect(String(first.cause)).toContain("composer-drafts");
    }

    shouldFail = false;
    await Effect.runPromise(
      clearMobileEnvironmentOwnedData(environmentId, {
        clearThreadOutbox,
        clearComposerDrafts,
      }),
    );
    expect(clearThreadOutbox).toHaveBeenCalledTimes(2);
    expect(clearComposerDrafts).toHaveBeenCalledTimes(2);
  });

  it("makes partial completion explicit and recovers on retry", async () => {
    const environmentId = EnvironmentId.make("environment-1");
    let draftAttempts = 0;
    const clearThreadOutbox = vi.fn(async () => undefined);
    const clearComposerDrafts = vi.fn(async () => {
      draftAttempts += 1;
      if (draftAttempts === 1) throw new Error("draft write failed");
    });

    await expect(
      Effect.runPromise(
        clearMobileEnvironmentOwnedData(environmentId, {
          clearThreadOutbox,
          clearComposerDrafts,
        }),
      ),
    ).rejects.toThrow();

    await Effect.runPromise(
      clearMobileEnvironmentOwnedData(environmentId, {
        clearThreadOutbox,
        clearComposerDrafts,
      }),
    );
    expect(clearThreadOutbox).toHaveBeenCalledTimes(2);
    expect(clearComposerDrafts).toHaveBeenCalledTimes(2);
  });
});
