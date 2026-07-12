import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { DraftId, useComposerDraftStore } from "./composerDraftStore";
import {
  textAttachmentClaimChanges,
  textAttachmentClaims,
  textAttachmentDraftOwnerId,
  TextAttachmentClaimReconciler,
  detachTextAttachmentClaimOwner,
  detachedTextAttachmentReleaseComplete,
  tombstoneTextAttachmentUploadOwner,
  fenceTextAttachmentUploadEnvironment,
  fenceTextAttachmentUploadOwner,
  getTextAttachmentClaimReconciler,
  pauseTextAttachmentClaimEnvironment,
  pendingTextAttachmentClaimReleases,
  reconcileTextAttachmentClaimsEnvironment,
  releaseTextAttachmentClaimsInBackground,
  resetTextAttachmentClaimRegistryForTest,
  resumeTextAttachmentClaimEnvironment,
  resumeTextAttachmentUploadEnvironment,
  resumeTextAttachmentUploadOwner,
  runTextAttachmentUpload,
  retryTextAttachmentOperation,
} from "./textAttachmentClaims";

const PATH = "/var/t3-data/attachments/text/12345678-1234-1234-1234-123456789abc/shared.txt";

afterEach(() => {
  resetTextAttachmentClaimRegistryForTest();
  useComposerDraftStore.setState({ pendingTextAttachmentReleases: [] });
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

  it("coalesces mounted composer and lifecycle reconciliation for unchanged paths", async () => {
    vi.useFakeTimers();
    const environmentId = EnvironmentId.make("coalesced-lifecycle-environment");
    const draft = DraftId.make("coalesced-draft");
    const draftOwnerId = textAttachmentDraftOwnerId(draft);
    const operations = {
      claim: vi.fn(async () => false),
      release: vi.fn(async () => true),
    };
    const reconciler = getTextAttachmentClaimReconciler({
      environmentId,
      draftOwnerId,
      operations,
    });
    const entries = [{ target: draft, prompt: `[shared.txt](${PATH})` }];

    reconciler.setDesiredPrompt(entries[0]!.prompt);
    reconcileTextAttachmentClaimsEnvironment(environmentId, entries, operations);
    reconcileTextAttachmentClaimsEnvironment(environmentId, entries, operations);
    await reconciler.settled();
    expect(operations.claim).toHaveBeenCalledOnce();

    reconcileTextAttachmentClaimsEnvironment(environmentId, entries, operations);
    await vi.advanceTimersByTimeAsync(249);
    expect(operations.claim).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(operations.claim).toHaveBeenCalledTimes(2));
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

  it("bounds permanently failing destructive releases", async () => {
    vi.useFakeTimers();
    const operation = vi.fn().mockResolvedValue(false);
    const result = retryTextAttachmentOperation(operation, {
      retryDelayMs: 10,
      maxRetryDelayMs: 10,
      maxAttempts: 3,
    });
    await vi.advanceTimersByTimeAsync(30);
    await expect(result).resolves.toBe(false);
    expect(operation).toHaveBeenCalledTimes(3);
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

  it("keeps destructive owner releases retrying after the foreground deadline", async () => {
    vi.useFakeTimers();
    const environmentId = EnvironmentId.make("destructive-release-outbox");
    const claims = [
      { path: `${PATH}.normal`, draftOwnerId: "thread:env:normal" },
      { path: `${PATH}.archived`, draftOwnerId: "thread:env:archived" },
      { path: `${PATH}.project`, draftOwnerId: "draft:project" },
      { path: `${PATH}.fenced-upload`, draftOwnerId: "draft:fenced-upload" },
    ];
    const attempts = new Map<string, number>();
    const release = vi.fn(async (claim: (typeof claims)[number]) => {
      const next = (attempts.get(claim.path) ?? 0) + 1;
      attempts.set(claim.path, next);
      return next > 1;
    });

    const foreground = releaseTextAttachmentClaimsInBackground({
      environmentId,
      claims,
      release,
      foregroundWaitMs: 25,
      retryDelayMs: 100,
    });
    await vi.advanceTimersByTimeAsync(25);
    await foreground;

    expect(pendingTextAttachmentClaimReleases(environmentId)).toEqual(claims);
    expect(release).toHaveBeenCalledTimes(4);

    await vi.advanceTimersByTimeAsync(100);

    expect(pendingTextAttachmentClaimReleases(environmentId)).toEqual([]);
    expect(release).toHaveBeenCalledTimes(8);
  });

  it("times out a hung background release and retries it", async () => {
    vi.useFakeTimers();
    const environmentId = EnvironmentId.make("hung-release-outbox");
    const releaseClaim = { path: PATH, draftOwnerId: "thread:env:hung" };
    const release = vi
      .fn<(claim: typeof releaseClaim) => Promise<boolean>>()
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValueOnce(true);

    const foreground = releaseTextAttachmentClaimsInBackground({
      environmentId,
      claims: [releaseClaim],
      release,
      foregroundWaitMs: 10,
      operationTimeoutMs: 50,
      retryDelayMs: 100,
    });
    await vi.advanceTimersByTimeAsync(10);
    await foreground;
    expect(pendingTextAttachmentClaimReleases(environmentId)).toEqual([releaseClaim]);

    await vi.advanceTimersByTimeAsync(140);

    expect(pendingTextAttachmentClaimReleases(environmentId)).toEqual([]);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("releases confirmed owner paths even when the cleared prompt has no links", async () => {
    const environmentId = EnvironmentId.make("destroyed-owner-with-stale-confirmation");
    const draftOwnerId = "thread:env:destroyed";
    const reconciler = getTextAttachmentClaimReconciler({
      environmentId,
      draftOwnerId,
      operations: {
        claim: vi.fn(async () => true),
        release: vi.fn(async () => false),
      },
    });
    reconciler.confirmPaths([PATH]);
    reconciler.setDesiredPaths([PATH]);
    await reconciler.settled();
    const release = vi.fn(async (_path: string, _draftOwnerId: string) => true);

    await releaseTextAttachmentClaimsInBackground({
      environmentId,
      claims: [],
      draftOwnerIds: [draftOwnerId],
      release: ({ path, draftOwnerId: ownerId }) => release(path, ownerId),
    });

    expect(release).toHaveBeenCalledWith(PATH, draftOwnerId);
    expect(pendingTextAttachmentClaimReleases(environmentId)).toEqual([]);
  });

  it("reconstructs the release outbox after a module restart and retries on reconnect", async () => {
    vi.useFakeTimers();
    const environmentId = EnvironmentId.make("restarted-release-outbox");
    const claim = { path: PATH, draftOwnerId: "thread:env:restarted" };
    const firstRelease = vi.fn(async () => false);
    const foreground = releaseTextAttachmentClaimsInBackground({
      environmentId,
      claims: [claim],
      release: firstRelease,
      foregroundWaitMs: 10,
      retryDelayMs: 10_000,
    });
    await vi.advanceTimersByTimeAsync(10);
    await foreground;

    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        partialize: (state: ReturnType<typeof useComposerDraftStore.getState>) => unknown;
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useComposerDraftStore.getState>,
        ) => ReturnType<typeof useComposerDraftStore.getState>;
      };
    };
    const options = persistApi.getOptions();
    const persistedState = options.partialize(useComposerDraftStore.getState());
    resetTextAttachmentClaimRegistryForTest();
    useComposerDraftStore.setState({ pendingTextAttachmentReleases: [] });
    const hydrated = options.merge(persistedState, useComposerDraftStore.getInitialState());
    useComposerDraftStore.setState({
      pendingTextAttachmentReleases: hydrated.pendingTextAttachmentReleases,
    });
    const reconnectRelease = vi.fn(async (_path: string, _draftOwnerId: string) => true);
    const operations = {
      claim: vi.fn(async () => true),
      release: (path: string, draftOwnerId: string) => reconnectRelease(path, draftOwnerId),
    };

    reconcileTextAttachmentClaimsEnvironment(environmentId, [], operations);
    await vi.waitFor(() => expect(pendingTextAttachmentClaimReleases(environmentId)).toEqual([]));

    expect(reconnectRelease).toHaveBeenCalledWith(PATH, claim.draftOwnerId);
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
      { force: true },
    );
    await background.settled();

    expect(background.snapshot().confirmed).toEqual(new Set([PATH]));
  });

  it("waits for an in-flight claim before environment release preparation", async () => {
    const environmentId = EnvironmentId.make("preparing-environment");
    let finishClaim: (claimed: boolean) => void = () => undefined;
    const operations = {
      claim: vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            finishClaim = resolve;
          }),
      ),
      release: vi.fn(async () => true),
    };
    const reconciler = getTextAttachmentClaimReconciler({
      environmentId,
      draftOwnerId: "draft:preparing",
      operations,
    });
    reconciler.setDesiredPaths([PATH]);
    await vi.waitFor(() => expect(operations.claim).toHaveBeenCalledOnce());

    let prepared = false;
    const prepare = pauseTextAttachmentClaimEnvironment(environmentId).then(() => {
      prepared = true;
    });
    await Promise.resolve();
    expect(prepared).toBe(false);

    finishClaim(true);
    await prepare;
    expect(prepared).toBe(true);
    expect(reconciler.snapshot().confirmed).toEqual(new Set([PATH]));
  });

  it("resumes claim reconciliation after environment preparation fails", async () => {
    vi.useFakeTimers();
    const environmentId = EnvironmentId.make("recoverable-environment");
    let online = false;
    const operations = {
      claim: vi.fn(async () => online),
      release: vi.fn(async () => online),
    };
    const reconciler = getTextAttachmentClaimReconciler({
      environmentId,
      draftOwnerId: "draft:recoverable",
      operations,
    });
    reconciler.setDesiredPaths([PATH]);
    await reconciler.settled();
    await pauseTextAttachmentClaimEnvironment(environmentId);

    online = true;
    resumeTextAttachmentClaimEnvironment(environmentId);
    await reconciler.settled();

    expect(reconciler.snapshot().confirmed).toEqual(new Set([PATH]));
  });

  it("reclaims paths partially released before environment preparation fails", async () => {
    const environmentId = EnvironmentId.make("partially-released-environment");
    const claim = vi.fn(async () => true);
    const operations = { claim, release: vi.fn(async () => true) };
    const reconciler = getTextAttachmentClaimReconciler({
      environmentId,
      draftOwnerId: "draft:partial-release",
      operations,
    });
    reconciler.setDesiredPaths([PATH]);
    await reconciler.settled();
    expect(claim).toHaveBeenCalledOnce();

    await pauseTextAttachmentClaimEnvironment(environmentId);
    // Preparation released this claim, then a later release failed.
    resumeTextAttachmentClaimEnvironment(environmentId);
    await reconciler.settled();

    expect(claim).toHaveBeenCalledTimes(2);
    expect(reconciler.snapshot().confirmed).toEqual(new Set([PATH]));
  });

  it("fences an in-flight thread upload and releases its late claim", async () => {
    const environmentId = EnvironmentId.make("thread-upload-environment");
    let finishUpload: (result: { path: string }) => void = () => undefined;
    const release = vi.fn(async () => undefined);
    const upload = runTextAttachmentUpload({
      environmentId,
      draftOwnerId: "thread:env:thread-a",
      upload: () =>
        new Promise<{ path: string }>((resolve) => {
          finishUpload = resolve;
        }),
      path: (result) => result.path,
      release,
    });

    const fence = fenceTextAttachmentUploadOwner(environmentId, "thread:env:thread-a");
    finishUpload({ path: PATH });
    await fence;

    await expect(upload).resolves.toBeNull();
    expect(release).toHaveBeenCalledWith(PATH);
  });

  it("rejects new project-owner uploads after destructive fencing", async () => {
    const environmentId = EnvironmentId.make("project-upload-environment");
    await fenceTextAttachmentUploadOwner(environmentId, "draft:project-draft");
    const upload = vi.fn(async () => ({ path: PATH }));

    await expect(
      runTextAttachmentUpload({
        environmentId,
        draftOwnerId: "draft:project-draft",
        upload,
        path: (result) => result.path,
        release: vi.fn(async () => undefined),
      }),
    ).resolves.toBeNull();
    expect(upload).not.toHaveBeenCalled();
  });

  it("fences all environment uploads and resumes them after cleanup abort", async () => {
    const environmentId = EnvironmentId.make("environment-upload-fence");
    let finishUpload: (result: { path: string }) => void = () => undefined;
    const first = runTextAttachmentUpload({
      environmentId,
      draftOwnerId: "draft:environment-draft",
      upload: () =>
        new Promise<{ path: string }>((resolve) => {
          finishUpload = resolve;
        }),
      path: (result) => result.path,
      release: vi.fn(async () => undefined),
    });
    const fence = fenceTextAttachmentUploadEnvironment(environmentId);
    finishUpload({ path: PATH });
    await fence;
    await expect(first).resolves.toBeNull();

    const newOwnerUpload = vi.fn(async () => ({ path: PATH }));
    await expect(
      runTextAttachmentUpload({
        environmentId,
        draftOwnerId: "draft:first-seen-after-prepare",
        upload: newOwnerUpload,
        path: (result) => result.path,
        release: vi.fn(async () => undefined),
      }),
    ).resolves.toBeNull();
    expect(newOwnerUpload).not.toHaveBeenCalled();

    resumeTextAttachmentUploadEnvironment(environmentId);
    await expect(
      runTextAttachmentUpload({
        environmentId,
        draftOwnerId: "draft:environment-draft",
        upload: async () => ({ path: PATH }),
        path: (result) => result.path,
        release: vi.fn(async () => undefined),
      }),
    ).resolves.toEqual({ path: PATH });
  });

  it("resumes an owner upload fence after thread or project deletion fails", async () => {
    const environmentId = EnvironmentId.make("failed-owner-delete");
    const draftOwnerId = "draft:failed-delete";
    await fenceTextAttachmentUploadOwner(environmentId, draftOwnerId);
    resumeTextAttachmentUploadOwner(environmentId, draftOwnerId);

    await expect(
      runTextAttachmentUpload({
        environmentId,
        draftOwnerId,
        upload: async () => ({ path: PATH }),
        path: (result) => result.path,
        release: vi.fn(async () => undefined),
      }),
    ).resolves.toEqual({ path: PATH });
  });

  it("keeps a successful destruction owner tombstoned", async () => {
    const environmentId = EnvironmentId.make("successful-owner-delete");
    const draftOwnerId = "draft:successful-delete";
    await fenceTextAttachmentUploadOwner(environmentId, draftOwnerId);
    tombstoneTextAttachmentUploadOwner(environmentId, draftOwnerId);
    const upload = vi.fn(async () => ({ path: PATH }));

    await expect(
      runTextAttachmentUpload({
        environmentId,
        draftOwnerId,
        upload,
        path: (result) => result.path,
        release: vi.fn(async () => undefined),
      }),
    ).resolves.toBeNull();
    expect(upload).not.toHaveBeenCalled();
  });
});
