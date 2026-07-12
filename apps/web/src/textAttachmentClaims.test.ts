import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { DraftId } from "./composerDraftStore";
import {
  textAttachmentClaimChanges,
  textAttachmentClaims,
  textAttachmentDraftOwnerId,
  TextAttachmentClaimReconciler,
  detachTextAttachmentClaimOwner,
  detachedTextAttachmentReleaseComplete,
  getTextAttachmentClaimReconciler,
  reconcileTextAttachmentClaimsEnvironment,
  resetTextAttachmentClaimRegistryForTest,
  retryTextAttachmentOperation,
} from "./textAttachmentClaims";

const PATH = "/var/t3-data/attachments/text/12345678-1234-1234-1234-123456789abc/shared.txt";

afterEach(() => {
  resetTextAttachmentClaimRegistryForTest();
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

  it("continues retrying claims beyond three failures with capped backoff", async () => {
    vi.useFakeTimers();
    const claim = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const reconciler = new TextAttachmentClaimReconciler({
      claim,
      release: vi.fn().mockResolvedValue(true),
      retryDelayMs: 100,
      maxRetryDelayMs: 200,
    });

    reconciler.setDesiredPaths([PATH]);
    await reconciler.settled();
    await vi.advanceTimersByTimeAsync(700);
    await reconciler.settled();

    expect(claim).toHaveBeenCalledTimes(5);
    expect(reconciler.snapshot().confirmed).toEqual(new Set([PATH]));
  });

  it("reconciles immediately when a connection resumes", async () => {
    vi.useFakeTimers();
    const claim = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const reconciler = new TextAttachmentClaimReconciler({
      claim,
      release: vi.fn().mockResolvedValue(true),
      retryDelayMs: 10_000,
    });

    reconciler.setDesiredPaths([PATH]);
    await reconciler.settled();
    reconciler.reconcileNow();
    await reconciler.settled();

    expect(claim).toHaveBeenCalledTimes(2);
    expect(reconciler.snapshot().confirmed).toEqual(new Set([PATH]));
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

  it("retries destructive bulk releases beyond three failures", async () => {
    vi.useFakeTimers();
    const operation = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const result = retryTextAttachmentOperation(operation, {
      retryDelayMs: 100,
      maxRetryDelayMs: 200,
    });
    await vi.advanceTimersByTimeAsync(700);

    await expect(result).resolves.toBe(true);
    expect(operation).toHaveBeenCalledTimes(5);
  });

  it("waits for an in-flight claim before detaching a destructively cleared owner", async () => {
    const environmentId = EnvironmentId.make("destructive-environment");
    const draftOwnerId = "draft:destructive";
    let finishClaim: (claimed: boolean) => void = () => undefined;
    const claim = vi.fn<(path: string) => Promise<boolean>>(
      (_path) =>
        new Promise<boolean>((resolve) => {
          finishClaim = resolve;
        }),
    );
    const operations = {
      claim: (path: string) => claim(path),
      release: vi.fn(async () => true),
    };
    const reconciler = getTextAttachmentClaimReconciler({
      environmentId,
      draftOwnerId,
      operations,
    });
    reconciler.setDesiredPaths([PATH]);
    await vi.waitFor(() => expect(claim).toHaveBeenCalledOnce());

    let detached = false;
    const detach = detachTextAttachmentClaimOwner(environmentId, draftOwnerId).then(() => {
      detached = true;
    });
    await Promise.resolve();
    expect(detached).toBe(false);

    finishClaim(true);
    await detach;
    expect(detached).toBe(true);
    expect(reconciler.snapshot().confirmed).toEqual(new Set([PATH]));
  });

  it("retries a released false result before destructive clear completes", async () => {
    vi.useFakeTimers();
    const release = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    const result = retryTextAttachmentOperation(release, { retryDelayMs: 100 });
    await vi.advanceTimersByTimeAsync(100);

    await expect(result).resolves.toBe(true);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("does not retry a permanently absent detached owner", async () => {
    const releaseRpc = vi.fn(async () => ({
      _tag: "Success" as const,
      value: { released: false },
    }));

    const completed = await retryTextAttachmentOperation(async () =>
      detachedTextAttachmentReleaseComplete(await releaseRpc()),
    );

    expect(completed).toBe(true);
    expect(releaseRpc).toHaveBeenCalledOnce();
  });

  it("cancels pending retry timers when disposed on unmount", async () => {
    vi.useFakeTimers();
    const claim = vi.fn().mockResolvedValue(false);
    const reconciler = new TextAttachmentClaimReconciler({
      claim,
      release: vi.fn().mockResolvedValue(true),
      retryDelayMs: 100,
    });

    reconciler.setDesiredPaths([PATH]);
    await reconciler.settled();
    reconciler.dispose();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(claim).toHaveBeenCalledOnce();
  });

  it("retries a background draft claim after navigation and reconnect", async () => {
    vi.useFakeTimers();
    const environmentId = EnvironmentId.make("offline-environment");
    const draft = DraftId.make("background-draft");
    const draftOwnerId = textAttachmentDraftOwnerId(draft);
    let online = false;
    const operations = {
      claim: vi.fn(async () => online),
      release: vi.fn(async () => online),
    };

    reconcileTextAttachmentClaimsEnvironment(
      environmentId,
      [{ target: draft, prompt: `[shared.txt](${PATH})` }],
      operations,
    );
    const background = getTextAttachmentClaimReconciler({
      environmentId,
      draftOwnerId,
      operations,
    });
    await background.settled();
    expect(background.snapshot().confirmed).toEqual(new Set());

    // Navigating away does not dispose the owner. A later reconnect reconciles
    // every persisted draft, including this now-background draft.
    online = true;
    reconcileTextAttachmentClaimsEnvironment(
      environmentId,
      [{ target: draft, prompt: `[shared.txt](${PATH})` }],
      operations,
    );
    await background.settled();

    expect(background.snapshot().confirmed).toEqual(new Set([PATH]));
  });
});
