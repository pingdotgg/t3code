/**
 * Host bridge for `t3.browser/surface@2.0.0` — the client-local half of the
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
  BROWSER_SURFACE_Z_INDEX,
  type BrowserSurfaceAcquireResult,
  type BrowserSurfaceDenialReason,
  type BrowserSurfaceEndReason,
  type BrowserSurfaceHost,
  type BrowserSurfaceLease,
  type BrowserSurfaceLeaseState,
  type BrowserSurfaceRect,
} from "@t3tools/extension-sdk/catalogue";
import { resourceKey, validateContext, type ViewContext } from "@t3tools/extension-sdk/contracts";

import { isElectron } from "~/env";
import { isHostedEngineClaimPending, useBrowserEngineHostStore } from "~/browser/browserEngineHost";
import {
  acquireBrowserSurface,
  useBrowserSurfaceStore,
  type BrowserSurfaceLease as NativeSurfaceLease,
  type BrowserSurfacePresentation,
  type BrowserExtensionTarget,
} from "~/browser/browserSurfaceStore";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
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
  readonly installationId?: string;
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
  readonly readEngineClaimPending: (runtimeTabId?: string, serverEpoch?: string) => boolean;
  readonly subscribeEngineClaims: (listener: () => void) => () => void;
  /** Frame coalescer — returns a cancel for the pending flush. */
  readonly schedule: (flush: () => void) => () => void;
  readonly mountSessionSync: (threadRef: ScopedThreadRef) => () => void;
  readonly readSessions: (threadRef: ScopedThreadRef) => ThreadPreviewState;
  readonly subscribeSessions: (threadRef: ScopedThreadRef, listener: () => void) => () => void;
  readonly acquireNative: (runtimeTabId: string, context: ViewContext) => NativeSurfaceLease;
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
    readEngineClaimPending: (runtimeTabId, serverEpoch) =>
      appAtomRegistry.get(primaryEnvironmentIdAtom) === environmentId &&
      isHostedEngineClaimPending(environmentId, runtimeTabId, serverEpoch),
    subscribeEngineClaims: (listener) => {
      const unsubscribeHost = useBrowserEngineHostStore.subscribe(listener);
      const unsubscribePrimary = appAtomRegistry.subscribe(primaryEnvironmentIdAtom, listener);
      return () => {
        unsubscribeHost();
        unsubscribePrimary();
      };
    },
    schedule: defaultSchedule,
    mountSessionSync: mountPreviewSessionSync,
    readSessions: readThreadPreviewState,
    subscribeSessions: (threadRef, listener) =>
      appAtomRegistry.subscribe(previewStateAtom(scopedThreadKey(threadRef)), listener),
    // The extension view paints its own device toolbar and commits resizes
    // through t3.browser/sessions, so the host's controls stand down.
    acquireNative: (runtimeTabId, context) =>
      acquireBrowserSurface(runtimeTabId, false, false, resourceKey(context.resource)),
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
    const targets = new Map<string, BrowserExtensionTarget>();
    binding.lifetime.addEventListener(
      "abort",
      () => {
        for (const [key, target] of targets)
          useBrowserSurfaceStore.getState().forgetExtension(key, target);
      },
      { once: true },
    );
    const presentation = deps.composites()
      ? ({ supported: true } as const)
      : ({ supported: false, reason: "desktop-required" } as const);
    return {
      id: BROWSER_SURFACE,
      version: BROWSER_SURFACE_VERSION,
      presentation,
      get engineClaimPending() {
        return presentation.supported && deps.readEngineClaimPending();
      },
      async acquire(request): Promise<BrowserSurfaceAcquireResult> {
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
        const key = resourceKey(context.resource);
        const requestedRuntimeTabId = previewRuntimeTabId(threadRef, serverEpoch, tabId);
        const target = {
          installationId: binding.installationId ?? "",
          tabId,
          serverEpoch,
          runtimeTabId: requestedRuntimeTabId,
        };
        targets.set(key, target);
        useBrowserSurfaceStore.getState().requestExtension(key, target);
        const forgetTarget = () => {
          if (targets.get(key) === target) targets.delete(key);
          useBrowserSurfaceStore.getState().forgetExtension(key, target);
        };
        const unmountSync = deps.mountSessionSync(threadRef);
        const synced = deps.readSessions(threadRef);
        if (synced.serverEpoch !== serverEpoch) {
          deps.refreshSessions(threadRef);
          const failure = await new Promise<BrowserSurfaceDenialReason | null>((resolve) => {
            let unsubscribe = () => {};
            let cancelDeadline = () => {};
            const finish = (reason: BrowserSurfaceDenialReason | null) => {
              unsubscribe();
              cancelDeadline();
              request.signal?.removeEventListener("abort", onScopeEnd);
              binding.lifetime.removeEventListener("abort", onLifetimeEnd);
              resolve(reason);
            };
            const onScopeEnd = () => finish("scope-invalid");
            const onLifetimeEnd = () => finish("host-unavailable");
            const check = () => {
              const current = deps.readSessions(threadRef);
              if (current.listSeq > synced.listSeq) finish(null);
              else if (current.listFailures > synced.listFailures) finish("host-unavailable");
            };
            unsubscribe = deps.subscribeSessions(threadRef, check);
            cancelDeadline = deps.defer(() => finish("host-unavailable"), VERIFY_TIMEOUT_MS);
            request.signal?.addEventListener("abort", onScopeEnd, { once: true });
            binding.lifetime.addEventListener("abort", onLifetimeEnd, { once: true });
            if (request.signal?.aborted) onScopeEnd();
            else if (binding.lifetime.aborted) onLifetimeEnd();
            else check();
          });
          const scope = deps.resolveThreadScope(threadRef);
          if (failure !== null || !scope.authoritative) {
            forgetTarget();
            unmountSync();
            return deny(failure ?? "host-unavailable", "The browser host is not connected.");
          }
          if (scope.projectId !== resource.projectId || request.signal?.aborted) {
            forgetTarget();
            unmountSync();
            return deny("scope-invalid", "The calling view no longer owns this thread.");
          }
          if (binding.lifetime.aborted) {
            forgetTarget();
            unmountSync();
            return deny("host-unavailable", "The installation's client lifetime has ended.");
          }
          if (deps.readSessions(threadRef).serverEpoch !== serverEpoch) {
            forgetTarget();
            unmountSync();
            return deny("epoch-changed", "The session belongs to a previous browser host.");
          }
        }

        const composite = presentation.supported;
        const runtimeTabId = previewRuntimeTabId(threadRef, serverEpoch, tabId);
        const native = composite ? deps.acquireNative(runtimeTabId, context) : null;
        const nativeOwner = composite ? deps.ownerOf(runtimeTabId) : null;
        // Read again after mounting: the mount may synchronously reconcile a
        // cached list. Absence only becomes authoritative once a list applied
        // AFTER this baseline still lacks the tab — a just-opened session that
        // committed before the fetch lands inside it, and one committed after
        // the subscription arrives as an event.
        const baseline = deps.readSessions(threadRef);

        let state: BrowserSurfaceLeaseState = {
          kind: "active",
          presentation,
          engineClaimPending: composite && deps.readEngineClaimPending(runtimeTabId, serverEpoch),
        };
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
        let unsubscribeEngineClaims: () => void = () => {};
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
          if (reason !== "superseded" && reason !== "released") forgetTarget();
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
          unsubscribeEngineClaims();
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
          unsubscribeEngineClaims = deps.subscribeEngineClaims(() => {
            if (state.kind === "ended") return;
            const engineClaimPending = deps.readEngineClaimPending(runtimeTabId, serverEpoch);
            if (state.engineClaimPending === engineClaimPending) return;
            state = { ...state, engineClaimPending };
            for (const listener of listeners) {
              try {
                listener(state);
              } catch {
                /* A failing plugin listener must not break the transition. */
              }
            }
          });
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
          present(rect, visible, cornerRadius = 0, zIndex = BROWSER_SURFACE_Z_INDEX) {
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
