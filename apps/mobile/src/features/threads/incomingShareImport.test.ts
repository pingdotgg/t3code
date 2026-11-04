import { AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import type { DraftComposerAttachment } from "../../lib/composerImages";
import type { IncomingShareDraft } from "../sharing/incoming-share-model";
import { undoComposerDraftMergeState, type ComposerDraft } from "../../state/use-composer-drafts";
import {
  makeIncomingShareImports,
  type ShareImportDeps,
  type ShareImportPhase,
  type ShareImportTarget,
  transitionShareImport,
} from "./incomingShareImport";

const destination = { environmentId: "env-1", projectId: "project-1" };
const edited: ComposerDraft = { text: "typed after the undo", attachments: [] };

/** The draft store's own undo, applied to the test's draft map. */
function undoInto(
  drafts: Map<string, ComposerDraft>,
  draftKey: string,
  snapshot: ComposerDraft,
  merged: ComposerDraft,
): void {
  const next = undoComposerDraftMergeState(Object.fromEntries(drafts), draftKey, snapshot, merged);
  drafts.clear();
  for (const [key, draft] of Object.entries(next)) drafts.set(key, draft);
}

function mergeInto(
  drafts: Map<string, ComposerDraft>,
  draftKey: string,
  content: {
    readonly text: string;
    readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  },
): void {
  const existing = drafts.get(draftKey) ?? { text: "", attachments: [] };
  drafts.set(draftKey, {
    text: `${existing.text}\n${content.text}`,
    attachments: [...existing.attachments, ...content.attachments],
  });
}

function fileAttachment(id: string): DraftComposerAttachment {
  return {
    id,
    type: "file",
    name: `${id}.txt`,
    mimeType: "text/plain",
    sizeBytes: 4,
    fileUri: `file:///${id}.txt`,
  };
}

function share(attachments: ReadonlyArray<DraftComposerAttachment> = []): IncomingShareDraft {
  return {
    schemaVersion: 1,
    id: "share-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    text: "shared text",
    attachments,
    warnings: [],
  };
}

function importTarget(overrides: Partial<ShareImportTarget> = {}): ShareImportTarget {
  return {
    flowKey: "flow-a",
    routeKey: "route-a",
    draftKey: "draft-a",
    destination,
    shareId: "share-1",
    ...overrides,
  };
}

function setup(overrides: Partial<ShareImportDeps> = {}) {
  const drafts = new Map<string, ComposerDraft>([["draft-a", { text: "mine", attachments: [] }]]);
  const inbox = new Map<string, IncomingShareDraft>([["share-1", share()]]);
  const calls: Array<string> = [];
  const registry = overrides.registry ?? AtomRegistry.make();
  const deps: ShareImportDeps = {
    registry,
    getShare: (shareId) => inbox.get(shareId) ?? null,
    reserve: vi.fn(async () => {
      calls.push("reserve");
    }),
    release: vi.fn(async () => {
      calls.push("release");
    }),
    consume: vi.fn(async () => {
      calls.push("consume");
    }),
    readDraft: (draftKey) => drafts.get(draftKey) ?? { text: "", attachments: [] },
    undoMerge: vi.fn(async (draftKey, snapshot, merged) => {
      calls.push("undo");
      undoInto(drafts, draftKey, snapshot, merged);
    }),
    mergeIntoDraft: vi.fn(async (draftKey, content) => {
      calls.push("merge");
      mergeInto(drafts, draftKey, content);
      return { skippedAttachmentCount: 0 };
    }),
    selectAttachments: (incoming) => ({
      status: "ready",
      attachments: incoming.attachments,
      warnings: [],
    }),
    releaseUnusedAttachments: vi.fn(),
    onWarnings: vi.fn(),
    onImportFailure: vi.fn(),
    onCancelFailure: vi.fn(),
    leave: vi.fn(),
    ...overrides,
  };
  const imports = makeIncomingShareImports(deps);
  const watch = (target: ShareImportTarget) => {
    const atom = imports.phaseAtom(target);
    const unmount = registry.mount(atom);
    registry.get(atom);
    return { phase: (): ShareImportPhase => registry.get(atom), unmount };
  };
  return { imports, deps, drafts, inbox, calls, watch, registry };
}

describe("transitionShareImport", () => {
  it("only cancels or retries from a failure, and keeps terminal phases terminal", () => {
    expect(transitionShareImport("attaching", "cancel")).toBe("attaching");
    expect(transitionShareImport("failed", "start")).toBe("reserving");
    expect(transitionShareImport("cancelling", "cancelFailed")).toBe("failed");
    expect(transitionShareImport("done", "start")).toBe("done");
    expect(transitionShareImport("cancelled", "start")).toBe("cancelled");
  });
});

describe("incoming share imports", () => {
  it("reserves, attaches and consumes once, releasing files the draft did not keep", async () => {
    const kept = fileAttachment("kept");
    const skipped = fileAttachment("skipped");
    const { deps, calls, drafts, inbox, imports, watch } = setup({
      selectAttachments: () => ({ status: "ready", attachments: [kept], warnings: ["too big"] }),
    });
    inbox.set("share-1", share([kept, skipped]));
    const target = importTarget();
    const watched = watch(target);

    expect(watched.phase()).toBe("reserving");
    await imports.settled(target);
    expect(watched.phase()).toBe("done");

    expect(calls).toEqual(["reserve", "merge", "consume"]);
    expect(drafts.get("draft-a")?.attachments).toEqual([kept]);
    expect(deps.releaseUnusedAttachments).toHaveBeenCalledWith([skipped]);
    expect(deps.onWarnings).toHaveBeenCalledWith(["too big"]);
  });

  it("runs once when its atom node is removed and rebuilt", async () => {
    const { imports, deps } = setup();
    const tasks: Array<() => void> = [];
    const registry = AtomRegistry.make({
      scheduleTask: (task) => {
        tasks.push(task);
        return () => undefined;
      },
    });
    const atom = imports.phaseAtom(importTarget());

    registry.get(atom);
    tasks.splice(0).forEach((task) => task());
    expect(registry.getNodes().size).toBe(0);
    const unmount = registry.mount(atom);
    await imports.settled(importTarget());
    expect(registry.get(atom)).toBe("done");
    unmount();

    expect(deps.reserve).toHaveBeenCalledTimes(1);
    expect(deps.consume).toHaveBeenCalledTimes(1);
  });

  it("cancel after a failed consume restores the draft, releases the reservation and leaves", async () => {
    const { deps, calls, drafts, watch, imports } = setup({
      consume: vi.fn(async () => {
        throw new Error("disk full");
      }),
    });
    const target = importTarget();
    const watched = watch(target);
    await imports.settled(target);
    expect(watched.phase()).toBe("failed");
    expect(deps.onImportFailure).toHaveBeenCalledWith(target, new Error("disk full"));

    await imports.cancel(target);

    expect(watched.phase()).toBe("cancelled");
    expect(calls).toEqual(["reserve", "merge", "undo", "release"]);
    expect(drafts.get("draft-a")).toEqual({ text: "mine", attachments: [] });
    // Unconsumed: the inbox still owns the files.
    expect(deps.releaseUnusedAttachments).not.toHaveBeenCalled();
    expect(deps.leave).toHaveBeenCalledWith(target);
  });

  it("a failed cancel can be retried and keeps the original backup", async () => {
    let releaseAttempts = 0;
    const { deps, drafts, watch, imports } = setup({
      consume: vi.fn(async () => {
        throw new Error("disk full");
      }),
      release: vi.fn(async () => {
        releaseAttempts += 1;
        if (releaseAttempts === 1) throw new Error("locked");
      }),
    });
    const target = importTarget();
    const watched = watch(target);
    await imports.settled(target);
    expect(watched.phase()).toBe("failed");

    await imports.cancel(target);
    expect(watched.phase()).toBe("failed");
    expect(deps.onCancelFailure).toHaveBeenCalledWith(target, new Error("locked"));
    expect(deps.leave).not.toHaveBeenCalled();

    await imports.cancel(target);
    expect(watched.phase()).toBe("cancelled");
    expect(deps.undoMerge).toHaveBeenCalledTimes(1);
    expect(drafts.get("draft-a")).toEqual({ text: "mine", attachments: [] });
    expect(deps.leave).toHaveBeenCalledTimes(1);
  });

  it("stops before consuming once its route leaves the stack", async () => {
    const mergeStarted = Promise.withResolvers<void>();
    const merged = Promise.withResolvers<{ readonly skippedAttachmentCount: number }>();
    const { deps, imports, watch } = setup({
      mergeIntoDraft: () => {
        mergeStarted.resolve();
        return merged.promise;
      },
    });
    const watched = watch(importTarget());
    await mergeStarted.promise;
    expect(watched.phase()).toBe("attaching");

    const pruned = imports.prune(new Set(["flow-b"]));
    merged.resolve({ skippedAttachmentCount: 0 });
    await pruned;

    expect(deps.consume).not.toHaveBeenCalled();
    expect(deps.onImportFailure).not.toHaveBeenCalled();
    watched.unmount();
  });

  const userChanges = [
    ["edited", (drafts: Map<string, ComposerDraft>) => drafts.set("draft-a", edited), edited],
    ["deleted", (drafts: Map<string, ComposerDraft>) => drafts.delete("draft-a"), undefined],
  ] as const;

  it.each(userChanges)(
    "a retried cancel keeps a draft the user %s after the undo was shown",
    async (_change, change, expected) => {
      let undoAttempts = 0;
      const { deps, drafts, watch, imports } = setup({
        consume: vi.fn(async () => {
          throw new Error("disk full");
        }),
        // Like undoComposerDraftMerge: publishes, then fails to persist.
        undoMerge: vi.fn(
          async (draftKey: string, snapshot: ComposerDraft, merged: ComposerDraft) => {
            undoAttempts += 1;
            undoInto(drafts, draftKey, snapshot, merged);
            if (undoAttempts === 1) throw new Error("write failed");
          },
        ),
      });
      const target = importTarget();
      const watched = watch(target);
      await imports.settled(target);
      await imports.cancel(target);
      expect(deps.onCancelFailure).toHaveBeenCalledWith(target, new Error("write failed"));

      change(drafts);
      await imports.cancel(target);

      expect(watched.phase()).toBe("cancelled");
      expect(drafts.get("draft-a")).toEqual(expected);
      expect(deps.release).toHaveBeenCalledTimes(1);
    },
  );

  it("cancel undoes the import after an upload finished on its attachment", async () => {
    const file = fileAttachment("file");
    const { drafts, inbox, watch, imports } = setup({
      consume: vi.fn(async () => {
        throw new Error("disk full");
      }),
    });
    inbox.set("share-1", share([file]));
    const target = importTarget();
    watch(target);
    await imports.settled(target);

    const merged = drafts.get("draft-a");
    drafts.set("draft-a", {
      text: merged?.text ?? "",
      attachments: [{ ...file, uploadedAttachmentId: "uploaded-1" }],
    });
    await imports.cancel(target);

    expect(drafts.get("draft-a")).toEqual({ text: "mine", attachments: [] });
  });

  it.each(userChanges)(
    "cancel keeps a draft the user %s after a merge that published but failed to persist",
    async (_change, change, expected) => {
      const { drafts, watch, imports } = setup({
        // Like mergeComposerDraftContent: publishes, then fails to persist.
        mergeIntoDraft: vi.fn(async (draftKey, content) => {
          mergeInto(drafts, draftKey, content);
          throw new Error("write failed");
        }),
      });
      const target = importTarget();
      const watched = watch(target);
      await imports.settled(target);
      expect(watched.phase()).toBe("failed");

      change(drafts);
      await imports.cancel(target);

      expect(watched.phase()).toBe("cancelled");
      expect(drafts.get("draft-a")).toEqual(expected);
    },
  );

  it("cancel after a merge that published but failed to persist removes the merged share", async () => {
    const { drafts, watch, imports } = setup({
      mergeIntoDraft: vi.fn(async (draftKey, content) => {
        mergeInto(drafts, draftKey, content);
        throw new Error("write failed");
      }),
    });
    const target = importTarget();
    watch(target);
    await imports.settled(target);

    await imports.cancel(target);

    expect(drafts.get("draft-a")).toEqual({ text: "mine", attachments: [] });
  });

  it("a failed import keeps its cancel after its route left, and reports a failed undo", async () => {
    const { calls, deps, imports, watch } = setup({
      consume: vi.fn(async () => {
        throw new Error("disk full");
      }),
      release: vi.fn(async () => {
        throw new Error("locked");
      }),
    });
    const target = importTarget();
    const watched = watch(target);
    await imports.settled(target);
    expect(watched.phase()).toBe("failed");
    watched.unmount();
    await imports.prune(new Set());

    await imports.cancel(target);

    expect(calls).toEqual(["reserve", "merge", "undo"]);
    expect(deps.onCancelFailure).toHaveBeenCalledWith(target, new Error("locked"));
    expect(deps.leave).not.toHaveBeenCalled();
  });

  it("a route switching drafts abandons the in-flight import", async () => {
    const reserved = Promise.withResolvers<void>();
    const { deps, imports, watch } = setup({
      reserve: vi.fn().mockReturnValueOnce(reserved.promise).mockResolvedValue(undefined),
    });
    watch(importTarget()).unmount();
    const secondTarget = importTarget({ draftKey: "draft-b" });
    const second = watch(secondTarget);
    reserved.resolve();

    await imports.settled(secondTarget);
    expect(second.phase()).toBe("done");
    expect(deps.mergeIntoDraft).toHaveBeenCalledTimes(1);
    expect(deps.mergeIntoDraft).toHaveBeenCalledWith("draft-b", expect.anything());
  });

  it("stays in flight for its route after the screen stops rendering its target", async () => {
    const mergeStarted = Promise.withResolvers<void>();
    const merged = Promise.withResolvers<{ readonly skippedAttachmentCount: number }>();
    const { imports, registry, watch } = setup({
      mergeIntoDraft: () => {
        mergeStarted.resolve();
        return merged.promise;
      },
    });
    const inFlight = imports.inFlightAtom("flow-a");
    const unmountInFlight = registry.mount(inFlight);
    const target = importTarget();
    const watched = watch(target);
    await mergeStarted.promise;

    watched.unmount();
    expect(registry.get(inFlight)).toBe(true);

    merged.resolve({ skippedAttachmentCount: 0 });
    await imports.settled(target);
    expect(registry.get(inFlight)).toBe(false);
    unmountInFlight();
  });
});
