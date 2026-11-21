import type { CanvasDocument, CanvasOp, EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { applyCanvasOps, makeCanvasNodeId } from "@t3tools/shared/canvasOps";
import { msg } from "gt-react";

import { toastManager } from "~/components/ui/toast";
import { m } from "~/i18n/messages";
import { pluginSharedState } from "~/plugins/features";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { canvasEnvironment } from "~/state/canvas";

import { invertCanvasOps } from "./canvasHistory";
import { followCanvasDocument, sendCanvasOps } from "./canvasRpc";
import type { CanvasEngine } from "./engine/CanvasEngine";

export type CanvasDocumentStatus = "loading" | "ready" | "deleted" | "failed";

interface PendingBatch {
  readonly id: string;
  readonly ops: ReadonlyArray<CanvasOp>;
  /** The server revision that applied it, once the send succeeds. */
  revision: number | null;
}

interface HistoryEntry {
  readonly undo: ReadonlyArray<CanvasOp>;
  readonly redo: ReadonlyArray<CanvasOp>;
}

const HISTORY_LIMIT = 200;

const applySafely = (doc: CanvasDocument, ops: ReadonlyArray<CanvasOp>) => {
  try {
    return applyCanvasOps(doc, ops);
  } catch {
    return null;
  }
};

/**
 * One live document shared by every mount (panel tab, floating player). The
 * server owns `confirmed`; local edits apply optimistically on top as pending
 * batches until their echo arrives, so remote batches rebase cleanly under
 * them. `view` adds a transient preview (a drag in progress) that is never sent.
 */
export class CanvasDocumentController {
  readonly environmentId: EnvironmentId;
  readonly documentId: string;
  private confirmed: CanvasDocument | null = null;
  private local: CanvasDocument | null = null;
  private view: CanvasDocument | null = null;
  private previewOps: ReadonlyArray<CanvasOp> | null = null;
  /** Ops covering every node that differs between the previous view and `view` (null: unknown). */
  private viewChange: {
    readonly from: CanvasDocument | null;
    readonly ops: ReadonlyArray<CanvasOp> | null;
  } = { from: null, ops: null };
  private pending: PendingBatch[] = [];
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private status: CanvasDocumentStatus = "loading";
  private readonly listeners = new Set<() => void>();
  private readonly engines = new Set<CanvasEngine>();
  private stopFollowing: (() => void) | null = null;
  /** Bumped per follow so a replaced stream's late events are ignored. */
  private followGeneration = 0;
  private batchCounter = 0;
  private readonly clientId = makeCanvasNodeId().slice(0, 8);

  constructor(environmentId: EnvironmentId, documentId: string) {
    this.environmentId = environmentId;
    this.documentId = documentId;
  }

  start() {
    if (this.stopFollowing) return;
    const generation = ++this.followGeneration;
    this.stopFollowing = followCanvasDocument(
      this.environmentId,
      this.documentId,
      (event) => {
        if (generation !== this.followGeneration) return;
        switch (event.type) {
          case "snapshot":
            this.confirmed = event.document;
            this.status = "ready";
            // A resubscribe can lose our echoes; the snapshot already has those batches.
            this.settlePending();
            this.rebase(null);
            break;
          case "ops": {
            if (!this.confirmed) return;
            const next = applySafely(this.confirmed, event.ops);
            if (!next) {
              this.resync();
              return;
            }
            this.confirmed = { ...next, revision: event.revision };
            const head = this.pending[0];
            if (head && event.clientBatchId === head.id) {
              // Our own echo, in order: local already contains it.
              this.pending.shift();
              return;
            }
            if (
              event.clientBatchId &&
              this.pending.some((batch) => batch.id === event.clientBatchId)
            ) {
              this.pending = this.pending.filter((batch) => batch.id !== event.clientBatchId);
            }
            this.rebase(event.ops);
            break;
          }
          case "deleted":
            this.status = "deleted";
            this.emit();
            break;
        }
      },
      () => {
        if (generation !== this.followGeneration || this.status === "deleted") return;
        this.status = "failed";
        this.emit();
      },
    );
  }

  stop() {
    this.followGeneration += 1;
    this.stopFollowing?.();
    this.stopFollowing = null;
    for (const engine of this.engines) engine.setSuspended(true);
  }

  /** Refetches a snapshot after a remote batch failed to apply; the view stays up meanwhile. */
  private resync() {
    const stale = this.stopFollowing;
    this.stopFollowing = null;
    this.followGeneration += 1;
    // Unmount outside the stream callback that is running right now.
    queueMicrotask(() => stale?.());
    this.start();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** What renders: local edits plus any in-progress preview. */
  getDocument = () => this.view;

  /**
   * How the current view was derived from the previous one. Engines pass
   * `ops` to `setDocument` when they last showed `from`, skipping an O(n) diff.
   */
  getViewChange = () => this.viewChange;

  /** Local edits without the preview: what the inspector shows and edits from. */
  getCommittedDocument = () => this.local;

  getStatus = () => this.status;

  canUndo = () => this.undoStack.length > 0;
  canRedo = () => this.redoStack.length > 0;

  /** Shows ops without sending them, e.g. every frame of a drag. */
  preview(ops: ReadonlyArray<CanvasOp>) {
    if (!this.local) return;
    const next = ops.length === 0 ? this.local : applySafely(this.local, ops);
    if (!next) return;
    this.setView(next, [...(this.previewOps ?? []), ...ops]);
    this.previewOps = ops.length === 0 ? null : ops;
    this.emit();
  }

  cancelPreview() {
    const previewOps = this.previewOps;
    this.previewOps = null;
    if (this.view === this.local) return;
    this.setView(this.local, previewOps);
    this.emit();
  }

  /** Applies ops locally, sends them, and records one undo step. */
  commit(ops: ReadonlyArray<CanvasOp>, options: { readonly history?: boolean } = {}): boolean {
    if (
      !isCanvasDocumentActive(this) ||
      !appAtomRegistry.get(canvasEnvironment.applyOps.permissionAtom(this.environmentId))
    ) {
      this.cancelPreview();
      return false;
    }
    if (!this.local || ops.length === 0) {
      this.cancelPreview();
      return false;
    }
    const inverse = options.history === false ? null : invertCanvasOps(this.local, ops);
    const next = applySafely(this.local, ops);
    if (!next) {
      this.cancelPreview();
      return false;
    }
    if (inverse) {
      this.undoStack.push({ undo: inverse, redo: ops });
      if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
      this.redoStack = [];
    }
    this.setView(next, [...(this.previewOps ?? []), ...ops]);
    this.previewOps = null;
    this.local = next;
    this.send(ops);
    this.emit();
    return true;
  }

  undo() {
    const entry = this.undoStack.pop();
    if (!entry) return;
    if (this.commit(entry.undo, { history: false })) this.redoStack.push(entry);
    else this.undoStack = [];
  }

  redo() {
    const entry = this.redoStack.pop();
    if (!entry) return;
    if (this.commit(entry.redo, { history: false })) this.undoStack.push(entry);
    else this.redoStack = [];
  }

  registerEngine(engine: CanvasEngine) {
    this.engines.add(engine);
    notifyMountedChange();
    return () => {
      this.engines.delete(engine);
      notifyMountedChange();
    };
  }

  /** Any engine currently showing this document, for agent screenshots. */
  anyEngine(): CanvasEngine | null {
    return this.engines.values().next().value ?? null;
  }

  private send(ops: ReadonlyArray<CanvasOp>) {
    const id = `${this.clientId}:${++this.batchCounter}`;
    const batch: PendingBatch = { id, ops, revision: null };
    this.pending.push(batch);
    void sendCanvasOps(this.environmentId, this.documentId, ops, id).then((result) => {
      if (result._tag === "Success") {
        batch.revision = result.value.revision;
        if (this.settlePending()) this.rebase(null);
        return;
      }
      // The edit never landed, so its undo step would invert nothing.
      const landed = (entry: HistoryEntry) => entry.redo !== ops && entry.undo !== ops;
      this.undoStack = this.undoStack.filter(landed);
      this.redoStack = this.redoStack.filter(landed);
      if (!this.pending.includes(batch)) return;
      this.pending = this.pending.filter((other) => other !== batch);
      this.rebase(batch.ops);
      toastManager.add({ type: "error", title: m(msg("Canvas edit was not saved")) });
    });
  }

  /** Drops sent batches that `confirmed` already contains. Returns whether any were dropped. */
  private settlePending(): boolean {
    const revision = this.confirmed?.revision;
    if (revision === undefined) return false;
    const before = this.pending.length;
    this.pending = this.pending.filter(
      (batch) => batch.revision === null || batch.revision > revision,
    );
    return this.pending.length !== before;
  }

  /** Recomputes local edits over `confirmed`. `changed`: ops that changed `confirmed` or dropped a batch (null: unknown). */
  private rebase(changed: ReadonlyArray<CanvasOp> | null) {
    if (!this.confirmed) return;
    let next = this.confirmed;
    const hint = changed ? [...changed, ...(this.previewOps ?? [])] : null;
    for (const batch of this.pending) {
      next = applySafely(next, batch.ops) ?? next;
      hint?.push(...batch.ops);
    }
    this.local = next;
    // Keep an in-progress preview (a drag, a hidden text node) over remote batches.
    this.setView((this.previewOps && applySafely(next, this.previewOps)) ?? next, hint);
    this.emit();
  }

  private setView(next: CanvasDocument | null, ops: ReadonlyArray<CanvasOp> | null) {
    this.viewChange = { from: this.view, ops };
    this.view = next;
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }
}

interface Entry {
  readonly controller: CanvasDocumentController;
  refs: number;
  stopTimer: number | null;
}

const canvasState = pluginSharedState("canvas-documents", () => ({
  controllers: new Map<string, Entry>(),
  environmentOwners: new Map<EnvironmentId, number>(),
  environmentCleanups: new Set<(environmentId: EnvironmentId) => void>(),
  mountedPanels: new Map<string, { environmentId: EnvironmentId; mounts: Set<symbol> }>(),
  mountedListeners: new Set<() => void>(),
  mountedVersion: 0,
}));
const { controllers, environmentOwners, environmentCleanups, mountedPanels } = canvasState;
const keyOf = (environmentId: EnvironmentId, documentId: string) =>
  `${environmentId}\u0000${documentId}`;

interface VisibleThreadHost {
  readonly ref: ScopedThreadRef;
  readonly root: HTMLElement;
  intersecting: boolean;
  visible: boolean;
}

// Chat roots outlive canvas plugin activation and module replacement.
const visibleThreadHosts = pluginSharedState(
  "canvas-visible-thread-hosts",
  () => new Map<symbol, VisibleThreadHost>(),
);

function isThreadHostVisible(host: VisibleThreadHost) {
  const { root } = host;
  if (
    !host.intersecting ||
    !root.isConnected ||
    root.closest('[hidden], [inert], [aria-hidden="true"]') ||
    !root.checkVisibility({ opacityProperty: true, visibilityProperty: true })
  )
    return false;
  const rect = root.getBoundingClientRect();
  const viewport = root.ownerDocument.documentElement;
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.right > 0 &&
    rect.bottom > 0 &&
    rect.left < viewport.clientWidth &&
    rect.top < viewport.clientHeight
  );
}

/** A connected visible conversation can open its own canvas without being the routed thread. */
export function registerVisibleCanvasThreadHost(ref: ScopedThreadRef, root: HTMLElement) {
  const mount = Symbol();
  const host: VisibleThreadHost = { ref, root, intersecting: true, visible: false };
  host.visible = isThreadHostVisible(host);
  visibleThreadHosts.set(mount, host);
  notifyMountedChange();
  const update = () => {
    if (visibleThreadHosts.get(mount) !== host) return;
    const visible = isThreadHostVisible(host);
    if (host.visible === visible) return;
    host.visible = visible;
    notifyMountedChange();
  };
  const intersections = new IntersectionObserver((entries) => {
    const entry = entries.at(-1);
    if (!entry) return;
    host.intersecting =
      entry.isIntersecting && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0;
    update();
  });
  intersections.observe(root);
  const mutations = new MutationObserver(update);
  for (let ancestor: HTMLElement | null = root; ancestor; ancestor = ancestor.parentElement) {
    mutations.observe(ancestor, {
      attributes: true,
      attributeFilter: ["class", "style", "hidden", "inert", "aria-hidden"],
    });
  }
  const onTransitionEnd = (event: Event) => {
    if (event.target instanceof Element && event.target.contains(root)) update();
  };
  root.ownerDocument.addEventListener("transitionend", onTransitionEnd);
  return () => {
    intersections.disconnect();
    mutations.disconnect();
    root.ownerDocument.removeEventListener("transitionend", onTransitionEnd);
    if (visibleThreadHosts.delete(mount)) notifyMountedChange();
  };
}

export function hasVisibleCanvasThreadHost(environmentId: EnvironmentId, threadId: string) {
  return [...visibleThreadHosts.values()].some(
    (host) =>
      host.ref.environmentId === environmentId &&
      host.ref.threadId === threadId &&
      isThreadHostVisible(host),
  );
}

/** Visible chat roots in one environment, deduplicated across mounts. */
export function visibleCanvasThreadIds(environmentId: EnvironmentId) {
  const ids = [...visibleThreadHosts.values()]
    .filter((host) => host.ref.environmentId === environmentId && isThreadHostVisible(host))
    .map((host) => host.ref.threadId);
  return [...new Set(ids)].toSorted();
}

/** Plugin disposal releases live subscriptions and caches, keeping durable documents and tabs. */
export function retainCanvasEnvironment(environmentId: EnvironmentId) {
  environmentOwners.set(environmentId, (environmentOwners.get(environmentId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const owners = (environmentOwners.get(environmentId) ?? 1) - 1;
    if (owners > 0) {
      environmentOwners.set(environmentId, owners);
      return;
    }
    environmentOwners.delete(environmentId);
    for (const cleanup of environmentCleanups) cleanup(environmentId);
    for (const [key, entry] of controllers) {
      if (entry.controller.environmentId !== environmentId) continue;
      if (entry.stopTimer !== null) window.clearTimeout(entry.stopTimer);
      entry.controller.stop();
      controllers.delete(key);
    }
    for (const [key, panel] of mountedPanels) {
      if (panel.environmentId === environmentId) mountedPanels.delete(key);
    }
    notifyMountedChange();
  };
}

export function onCanvasEnvironmentDisposed(cleanup: (environmentId: EnvironmentId) => void) {
  environmentCleanups.add(cleanup);
  return () => {
    environmentCleanups.delete(cleanup);
  };
}

export function isCanvasDocumentActive(controller: CanvasDocumentController) {
  return (
    environmentOwners.has(controller.environmentId) &&
    controllers.get(keyOf(controller.environmentId, controller.documentId))?.controller ===
      controller
  );
}

const panelKey = (ref: ScopedThreadRef, documentId: string | null) =>
  JSON.stringify([ref.environmentId, ref.threadId, documentId]);

/** A visible picker or editor panel, used to acknowledge an agent's open request. */
export function registerMountedCanvasPanel(ref: ScopedThreadRef, documentId: string | null) {
  const key = panelKey(ref, documentId);
  const entry = mountedPanels.get(key) ?? {
    environmentId: ref.environmentId,
    mounts: new Set<symbol>(),
  };
  const mount = Symbol();
  entry.mounts.add(mount);
  mountedPanels.set(key, entry);
  notifyMountedChange();
  return () => {
    entry.mounts.delete(mount);
    if (entry.mounts.size === 0 && mountedPanels.get(key) === entry) mountedPanels.delete(key);
    notifyMountedChange();
  };
}

export function isCanvasPanelMounted(ref: ScopedThreadRef, documentId: string | null) {
  return (mountedPanels.get(panelKey(ref, documentId))?.mounts.size ?? 0) > 0;
}

/**
 * Shares one controller per document. A short grace period on release lets
 * the panel hand a document to the floating player without a resubscribe.
 */
export function acquireCanvasDocument(
  environmentId: EnvironmentId,
  documentId: string,
): { readonly controller: CanvasDocumentController; readonly release: () => void } {
  const key = keyOf(environmentId, documentId);
  let entry = controllers.get(key);
  if (!entry) {
    entry = {
      controller: new CanvasDocumentController(environmentId, documentId),
      refs: 0,
      stopTimer: null,
    };
    controllers.set(key, entry);
    entry.controller.start();
  }
  const current = entry;
  current.refs += 1;
  if (current.stopTimer !== null) {
    window.clearTimeout(current.stopTimer);
    current.stopTimer = null;
  }
  let released = false;
  return {
    controller: current.controller,
    release: () => {
      if (released) return;
      released = true;
      current.refs -= 1;
      if (current.refs > 0) return;
      if (controllers.get(key) !== current) return;
      current.stopTimer = window.setTimeout(() => {
        if (current.refs > 0) return;
        current.controller.stop();
        if (controllers.get(key) === current) controllers.delete(key);
      }, 2_000);
    },
  };
}

export function getCanvasDocumentController(environmentId: EnvironmentId, documentId: string) {
  return controllers.get(keyOf(environmentId, documentId))?.controller ?? null;
}

/** The engine showing a document in this window, for agent screenshots. */
export function findMountedCanvasEngine(
  environmentId: EnvironmentId,
  documentId: string,
): CanvasEngine | null {
  return controllers.get(keyOf(environmentId, documentId))?.controller.anyEngine() ?? null;
}

/** Documents with a live engine in one environment, sorted for stable reports. */
export function mountedCanvasDocumentIds(environmentId: EnvironmentId): string[] {
  return [...controllers.values()]
    .filter(
      (entry) =>
        entry.controller.environmentId === environmentId && entry.controller.anyEngine() !== null,
    )
    .map((entry) => entry.controller.documentId)
    .toSorted();
}

function notifyMountedChange() {
  canvasState.mountedVersion += 1;
  for (const listener of canvasState.mountedListeners) listener();
}

export function subscribeMountedCanvasDocuments(listener: () => void) {
  canvasState.mountedListeners.add(listener);
  return () => {
    canvasState.mountedListeners.delete(listener);
  };
}

export const getMountedCanvasVersion = () => canvasState.mountedVersion;
