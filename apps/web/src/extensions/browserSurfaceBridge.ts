/**
 * Host bridge for `t3.browser/surface@1.0.0` — the client-local half of the
 * contract. `installedController` invokes the returned factory once per
 * installed client, so each `ClientHost.browserSurface` binds that
 * installation's grant set and lifetime.
 *
 * The bridge maps the public session identity (thread scope + server tabId +
 * serverEpoch) onto the runtime tab id the private lease registry is keyed
 * by, keeps the thread's preview-session sync alive while a lease is held so
 * the engine host mounts the webview, and coalesces `present` calls into one
 * latest-wins store write per scheduled frame. Non-compositing clients still
 * get a lease — `present` reports the named "uncomposited" state rather than
 * dropping bounds silently.
 */
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  BROWSER_SURFACE,
  BROWSER_SURFACE_REQUIRED_GRANTS,
  BROWSER_SURFACE_VERSION,
  type BrowserSurfaceAcquireResult,
  type BrowserSurfaceDenialReason,
  type BrowserSurfaceEndReason,
  type BrowserSurfaceHost,
  type BrowserSurfaceLease,
  type BrowserSurfaceLeaseState,
  type BrowserSurfaceRect,
} from "@t3tools/extension-sdk/catalogue";
import { validateContext } from "@t3tools/extension-sdk/contracts";

import { isElectron } from "~/env";
import {
  acquireBrowserSurface,
  useBrowserSurfaceStore,
  type BrowserSurfaceLease as NativeSurfaceLease,
  type BrowserSurfacePresentation,
} from "~/browser/browserSurfaceStore";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import {
  mountPreviewSessionSync,
  refreshPreviewSessionList,
} from "~/components/preview/usePreviewSession";
import {
  previewStateAtom,
  readThreadPreviewState,
  type ThreadPreviewState,
} from "~/previewStateStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentShell } from "~/state/shell";
import { environmentThreadShells } from "~/state/threads";

export interface BrowserSurfaceBinding {
  /** The installation's grant set — the authority every acquire checks. */
  readonly grants: {
    readonly capabilities: readonly string[];
    readonly projectIds: readonly string[];
  };
  /** Aborting ends every lease the installation holds with "grant-revoked". */
  readonly lifetime: AbortSignal;
}

/** Seams the tests substitute; production defaults hit the real stores. */
export interface BrowserSurfaceBridgeDeps {
  readonly composites: () => boolean;
  /** Frame coalescer — returns a cancel for the pending flush. */
  readonly schedule: (flush: () => void) => () => void;
  readonly mountSessionSync: (threadRef: ScopedThreadRef) => () => void;
  readonly readSessions: (threadRef: ScopedThreadRef) => ThreadPreviewState;
  readonly subscribeSessions: (threadRef: ScopedThreadRef, listener: () => void) => () => void;
  readonly acquireNative: (runtimeTabId: string) => NativeSurfaceLease;
  readonly ownerOf: (runtimeTabId: string) => symbol | null;
  readonly subscribeStore: (
    listener: (state: {
      readonly byTabId: Readonly<Record<string, BrowserSurfacePresentation>>;
    }) => void,
  ) => () => void;
  /**
   * Thread → project from the orchestration shell. Only a `live` shell is
   * authority — `cached`/`synchronizing`/`empty` snapshots are last-known or
   * partially applied data and must not authorize a claim, so they report
   * `authoritative: false`. The caller-supplied projectId in the view context
   * is never authority either: a granted project paired with a foreign thread
   * must not claim that thread's surface.
   */
  readonly resolveThreadScope: (threadRef: ScopedThreadRef) => {
    readonly projectId: string | null;
    readonly authoritative: boolean;
  };
  /**
   * Fires when the environment's shell state changes — status transitions and
   * every applied snapshot — so a thread record's project and the authority
   * to trust it are both re-read on each change.
   */
  readonly subscribeThread: (threadRef: ScopedThreadRef, listener: () => void) => () => void;
  /** Forces a fresh preview.list round-trip for the thread. */
  readonly refreshSessions: (threadRef: ScopedThreadRef) => void;
  /** Bounded-delay scheduler for the arbitration deadline — returns a cancel. */
  readonly defer: (fn: () => void, ms: number) => () => void;
}

const defaultSchedule = (flush: () => void) => {
  if (typeof requestAnimationFrame === "function") {
    const id = requestAnimationFrame(flush);
    return () => cancelAnimationFrame(id);
  }
  const id = setTimeout(flush, 16);
  return () => clearTimeout(id);
};

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/**
 * Bound for verifying a session the synced state has never reported. A
 * `preview.list` request that stays pending (the query awaits connectivity
 * forever) or completes in Failure is not evidence of absence — but an
 * unverified lease must not hold its claim and sync mount indefinitely, so
 * arbitration retries a few failed requests inside one overall deadline.
 */
const VERIFY_ATTEMPT_LIMIT = 3;
const VERIFY_TIMEOUT_MS = 30_000;

const deny = (reason: BrowserSurfaceDenialReason, detail: string, grant?: string) =>
  ({
    ok: false,
    denial: { reason, detail, ...(grant === undefined ? {} : { grant }) },
  }) satisfies BrowserSurfaceAcquireResult;

export function createBrowserSurfaceBridge(
  environmentId: string,
  overrides: Partial<BrowserSurfaceBridgeDeps> = {},
): (binding: BrowserSurfaceBinding) => BrowserSurfaceHost {
  const deps: BrowserSurfaceBridgeDeps = {
    composites: () => isElectron,
    schedule: defaultSchedule,
    mountSessionSync: mountPreviewSessionSync,
    readSessions: readThreadPreviewState,
    subscribeSessions: (threadRef, listener) =>
      appAtomRegistry.subscribe(previewStateAtom(scopedThreadKey(threadRef)), listener),
    acquireNative: (runtimeTabId) => acquireBrowserSurface(runtimeTabId),
    ownerOf: (runtimeTabId) =>
      useBrowserSurfaceStore.getState().byTabId[runtimeTabId]?.owner ?? null,
    subscribeStore: (listener) => useBrowserSurfaceStore.subscribe(listener),
    resolveThreadScope: (threadRef) => {
      const shell = appAtomRegistry.get(environmentShell.stateValueAtom(threadRef.environmentId));
      if (shell.status !== "live") return { projectId: null, authoritative: false };
      return {
        projectId:
          appAtomRegistry.get(environmentThreadShells.threadShellAtom(threadRef))?.projectId ??
          null,
        authoritative: true,
      };
    },
    subscribeThread: (threadRef, listener) =>
      appAtomRegistry.subscribe(environmentShell.stateValueAtom(threadRef.environmentId), listener),
    refreshSessions: refreshPreviewSessionList,
    defer: (fn, ms) => {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    },
    ...overrides,
  };
  // Plugin-vs-plugin supersession registry — covers clients with no
  // compositor, where the native store is never claimed. On compositing
  // clients the store-owner watch additionally catches native slots (the
  // built-in Browser panel) stealing the same runtime tab.
  const pluginOwners = new Map<string, { readonly supersede: () => void }>();

  return (binding) => {
    const presentation = deps.composites()
      ? ({ supported: true } as const)
      : ({ supported: false, reason: "desktop-required" } as const);
    return {
      id: BROWSER_SURFACE,
      version: BROWSER_SURFACE_VERSION,
      presentation,
      acquire(request): BrowserSurfaceAcquireResult {
        if (binding.lifetime.aborted)
          return deny("host-unavailable", "the installation's client lifetime has already ended.");
        for (const grant of BROWSER_SURFACE_REQUIRED_GRANTS)
          if (!binding.grants.capabilities.includes(grant))
            return deny(
              "grant-denied",
              `${BROWSER_SURFACE} presentation requires the ${grant} installation grant.`,
              grant,
            );
        let context;
        try {
          context = validateContext(request.context);
        } catch (error) {
          return deny(
            "scope-invalid",
            error instanceof Error ? error.message : "Invalid view context.",
          );
        }
        const resource = context.resource;
        if (resource.environmentId !== environmentId || !resource.threadId || !resource.projectId)
          return deny(
            "scope-invalid",
            `${BROWSER_SURFACE} requires a thread-scoped context in this environment and a granted project.`,
          );
        const threadRef = {
          environmentId: resource.environmentId,
          threadId: resource.threadId,
        } as ScopedThreadRef;
        // The context's projectId is caller-supplied — resolve the thread's
        // real project from the orchestration shell before mounting sync or
        // claiming the store, matching the brokered sessions scope resolver.
        // Only a live shell answers; cached or synchronizing snapshots can
        // still describe a previous ownership.
        const threadScope = deps.resolveThreadScope(threadRef);
        if (!threadScope.authoritative)
          return deny(
            "host-unavailable",
            `${BROWSER_SURFACE} cannot verify the thread's project until this environment's data is live; retry once synchronization completes.`,
          );
        if (
          threadScope.projectId === null ||
          threadScope.projectId !== resource.projectId ||
          !binding.grants.projectIds.includes(threadScope.projectId)
        )
          return deny(
            "scope-invalid",
            `${BROWSER_SURFACE} requires a thread inside a granted project; the supplied project does not own this thread.`,
          );
        const tabId = request.session?.tabId;
        const serverEpoch = request.session?.serverEpoch;
        if (
          typeof tabId !== "string" ||
          !tabId ||
          tabId.length > 128 ||
          typeof serverEpoch !== "string" ||
          !serverEpoch ||
          serverEpoch.length > 128
        )
          return deny(
            "session-invalid",
            "session identity must come from t3.browser/sessions (tabId + serverEpoch).",
          );
        if (request.signal?.aborted)
          return deny("scope-invalid", "the calling view's lifetime has already ended.");
        const synced = deps.readSessions(threadRef);
        if (synced.serverEpoch !== null && synced.serverEpoch !== serverEpoch)
          return deny(
            "epoch-changed",
            `the synced server epoch has moved past this session's epoch; re-list sessions and acquire again.`,
          );

        const composite = presentation.supported;
        const unmountSync = deps.mountSessionSync(threadRef);
        const runtimeTabId = previewRuntimeTabId(threadRef, serverEpoch, tabId);
        const native = composite ? deps.acquireNative(runtimeTabId) : null;
        const nativeOwner = composite ? deps.ownerOf(runtimeTabId) : null;
        // Read again after mounting: the mount may synchronously reconcile a
        // cached list. Absence only becomes authoritative once a list applied
        // AFTER this baseline still lacks the tab — a just-opened session that
        // committed before the fetch lands inside it, and one committed after
        // the subscription arrives as an event.
        const baseline = deps.readSessions(threadRef);

        let state: BrowserSurfaceLeaseState = { kind: "active", presentation };
        const listeners = new Set<(next: BrowserSurfaceLeaseState) => void>();
        let pending: {
          rect: BrowserSurfaceRect;
          visible: boolean;
          cornerRadius: number;
          zIndex: number;
        } | null = null;
        let cancelFlush: (() => void) | null = null;
        let cancelVerifyDeadline: (() => void) | null = null;
        let unsubscribeSessions: () => void = () => {};
        let unsubscribeStore: () => void = () => {};
        let unsubscribeThread: () => void = () => {};
        let detachSignals: () => void = () => {};
        // Session-close honesty needs a baseline: a tab reported closed is one
        // this client observed (sessionSeen) or one a post-acquire list proves
        // absent (listSeq advanced past the baseline without the tab).
        let sessionSeen = baseline.sessions[tabId] !== undefined;
        let seenFailures = baseline.listFailures;
        let verifyAttempts = 0;
        const beginVerify = () => {
          verifyAttempts += 1;
          deps.refreshSessions(threadRef);
        };

        const entry = {
          supersede: () => end("superseded"),
        };

        function end(reason: BrowserSurfaceEndReason) {
          if (state.kind === "ended") return;
          state = { kind: "ended", reason };
          if (cancelFlush) {
            cancelFlush();
            cancelFlush = null;
          }
          pending = null;
          if (cancelVerifyDeadline) {
            cancelVerifyDeadline();
            cancelVerifyDeadline = null;
          }
          unsubscribeSessions();
          unsubscribeStore();
          unsubscribeThread();
          detachSignals();
          if (pluginOwners.get(runtimeTabId) === entry) pluginOwners.delete(runtimeTabId);
          native?.release();
          unmountSync();
          for (const listener of listeners) {
            try {
              listener(state);
            } catch {
              /* A failing plugin listener must not break the transition. */
            }
          }
          listeners.clear();
        }

        function flush() {
          cancelFlush = null;
          const update = pending;
          pending = null;
          if (!update || state.kind === "ended" || !native) return;
          if (!native.present(update.rect, update.visible, update.cornerRadius, update.zIndex))
            end("superseded");
        }

        unsubscribeSessions = deps.subscribeSessions(threadRef, () => {
          if (state.kind === "ended") return;
          const current = deps.readSessions(threadRef);
          if (current.serverEpoch !== null && current.serverEpoch !== serverEpoch) {
            end("epoch-changed");
            return;
          }
          if (current.sessions[tabId] !== undefined) {
            sessionSeen = true;
            if (cancelVerifyDeadline) {
              cancelVerifyDeadline();
              cancelVerifyDeadline = null;
            }
          } else if (sessionSeen || current.listSeq > baseline.listSeq) {
            end("session-closed");
          } else if (current.listFailures > seenFailures) {
            // A failed arbitration request proves nothing about the tab —
            // retry inside the attempt bound; the deadline still applies.
            seenFailures = current.listFailures;
            if (verifyAttempts < VERIFY_ATTEMPT_LIMIT) beginVerify();
          }
        });
        unsubscribeThread = deps.subscribeThread(threadRef, () => {
          if (state.kind === "ended") return;
          const scope = deps.resolveThreadScope(threadRef);
          // Only a live shell can move the claim — losing synchronization is
          // not evidence the thread moved; the next live application
          // re-validates and ends the lease on contradiction.
          if (scope.authoritative && scope.projectId !== resource.projectId)
            end("scope-invalidated");
        });
        // A never-seen tab must be verified, not trusted: force an
        // arbitrating preview.list dispatched after this acquire. Success
        // decides presence vs. session-closed; failures retry within the
        // attempt bound; the deadline ends an unverifiable lease honestly
        // instead of letting it hold the claim forever.
        if (!sessionSeen) {
          beginVerify();
          cancelVerifyDeadline = deps.defer(() => {
            if (!sessionSeen) end("session-unverified");
          }, VERIFY_TIMEOUT_MS);
        }
        if (composite) {
          unsubscribeStore = deps.subscribeStore((storeState) => {
            if (state.kind === "ended") return;
            if ((storeState.byTabId[runtimeTabId]?.owner ?? null) !== nativeOwner)
              end("superseded");
          });
        }
        const onScopeEnd = () => end("scope-invalidated");
        const onLifetimeEnd = () => end("grant-revoked");
        request.signal?.addEventListener("abort", onScopeEnd, { once: true });
        binding.lifetime.addEventListener("abort", onLifetimeEnd, { once: true });
        detachSignals = () => {
          request.signal?.removeEventListener("abort", onScopeEnd);
          binding.lifetime.removeEventListener("abort", onLifetimeEnd);
        };

        pluginOwners.get(runtimeTabId)?.supersede();
        pluginOwners.set(runtimeTabId, entry);

        const lease: BrowserSurfaceLease = {
          session: { tabId, serverEpoch },
          get state() {
            return state;
          },
          onDidChangeState(listener) {
            if (state.kind === "ended") return () => {};
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          },
          present(rect, visible, cornerRadius = 0, zIndex = 30) {
            if (state.kind === "ended") return "ended";
            if (!composite) return "uncomposited";
            if (
              !rect ||
              !isFiniteNumber(rect.x) ||
              !isFiniteNumber(rect.y) ||
              !isFiniteNumber(rect.width) ||
              !isFiniteNumber(rect.height) ||
              rect.width < 0 ||
              rect.height < 0 ||
              !isFiniteNumber(cornerRadius) ||
              !isFiniteNumber(zIndex)
            )
              throw new Error(`${BROWSER_SURFACE} present requires finite bounds.`);
            pending = {
              rect: {
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                width: Math.max(1, Math.round(rect.width)),
                height: Math.max(1, Math.round(rect.height)),
              },
              visible: visible === true,
              cornerRadius: Math.max(0, cornerRadius),
              zIndex: Math.round(zIndex),
            };
            // One scheduled flush per frame, latest wins — no queue.
            if (!cancelFlush) cancelFlush = deps.schedule(flush);
            return "accepted";
          },
          release() {
            end("released");
          },
        };
        return { ok: true, lease };
      },
    };
  };
}
