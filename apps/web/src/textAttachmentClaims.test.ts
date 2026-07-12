import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { DraftId } from "./composerDraftStore";
import {
  textAttachmentClaimChanges,
  textAttachmentClaims,
  textAttachmentDraftOwnerId,
  TextAttachmentClaimReconciler,
  retryTextAttachmentOperation,
} from "./textAttachmentClaims";

const PATH = "/var/t3-data/attachments/text/12345678-1234-1234-1234-123456789abc/shared.txt";

afterEach(() => {
  vi.useRealTimers();
});

describe("text attachment claims", () => {
  it("uses stable owner ids for draft and server composer targets", () => {
    expect(textAttachmentDraftOwnerId(DraftId.make("draft-a"))).toBe("draft:draft-a");
    expect(
      textAttachmentDraftOwnerId(
        scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("thread-a")),
      ),
    ).toBe("thread:local:thread-a");
  });

  it("claims every hydrated or copied generated link after remount", () => {
    expect(textAttachmentClaimChanges(new Set(), `[shared.txt](${PATH})`)).toMatchObject({
      claim: [PATH],
      release: [],
    });
  });

  it("releases a removed link and reclaims it after rapid undo", () => {
    const removed = textAttachmentClaimChanges(new Set([PATH]), "");
    const restored = textAttachmentClaimChanges(removed.nextPaths, `[shared.txt](${PATH})`);

    expect(removed.release).toEqual([PATH]);
    expect(restored.claim).toEqual([PATH]);
  });

  it("gives copied shared links independent draft claims", () => {
    expect(textAttachmentClaims(DraftId.make("draft-a"), `[shared.txt](${PATH})`)).toEqual([
      { path: PATH, draftOwnerId: "draft:draft-a" },
    ]);
    expect(textAttachmentClaims(DraftId.make("draft-b"), `[shared.txt](${PATH})`)).toEqual([
      { path: PATH, draftOwnerId: "draft:draft-b" },
    ]);
  });

  it("retries a failed claim without marking it confirmed", async () => {
    vi.useFakeTimers();
    const claim = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const reconciler = new TextAttachmentClaimReconciler({
      claim,
      release: vi.fn().mockResolvedValue(true),
      retryDelayMs: 100,
    });

    reconciler.setDesiredPaths([PATH]);
    await reconciler.settled();
    expect(reconciler.snapshot()).toEqual({ desired: new Set([PATH]), confirmed: new Set() });

    await vi.advanceTimersByTimeAsync(100);
    await reconciler.settled();
    expect(reconciler.snapshot().confirmed).toEqual(new Set([PATH]));
    expect(claim).toHaveBeenCalledTimes(2);
  });

  it("retries a failed imperative release without forgetting the claim", async () => {
    vi.useFakeTimers();
    const release = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const reconciler = new TextAttachmentClaimReconciler({
      claim: vi.fn().mockResolvedValue(true),
      release,
      retryDelayMs: 100,
    });
    reconciler.setDesiredPaths([PATH]);
    await reconciler.settled();

    reconciler.setDesiredPaths([]);
    await reconciler.settled();
    expect(reconciler.snapshot()).toEqual({ desired: new Set(), confirmed: new Set([PATH]) });

    await vi.advanceTimersByTimeAsync(100);
    await reconciler.settled();
    expect(reconciler.snapshot().confirmed).toEqual(new Set());
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("reconciles rapid remove and undo to a confirmed claim", async () => {
    const release = vi.fn().mockResolvedValue(true);
    const reconciler = new TextAttachmentClaimReconciler({
      claim: vi.fn().mockResolvedValue(true),
      release,
    });
    reconciler.setDesiredPaths([PATH]);
    await reconciler.settled();

    reconciler.setDesiredPaths([]);
    reconciler.setDesiredPaths([PATH]);
    await reconciler.settled();

    expect(reconciler.snapshot()).toEqual({
      desired: new Set([PATH]),
      confirmed: new Set([PATH]),
    });
    expect(release).not.toHaveBeenCalled();
  });

  it("retries destructive bulk releases", async () => {
    vi.useFakeTimers();
    const operation = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    const result = retryTextAttachmentOperation(operation, { retryDelayMs: 100 });
    await vi.advanceTimersByTimeAsync(100);

    await expect(result).resolves.toBe(true);
    expect(operation).toHaveBeenCalledTimes(2);
  });
});
