/**
 * Host bridge for the presenter half of `t3.browser/frames@1.0.0` — the
 * client-local transport behind `ClientHost.browserFrames`. The bridge
 * resolves this environment's `/api/browser-frames` endpoint from the
 * prepared connection, mounts a frame element inside the caller's slot,
 * and runs the shared `createBrowserFrameClient` transport. Authorization
 * is never asserted here: the caller supplies lease-bound mints, so a
 * caller without the grants produces no working tickets.
 *
 * Pointer/wheel/keyboard listeners live on the mounted element — the caller
 * renders overlays as ordinary DOM above it, and coordinate normalization
 * happens against the painted frame's rect.
 */
import {
  BROWSER_FRAMES,
  BROWSER_FRAMES_VERSION,
  BROWSER_SESSIONS,
  type BrowserFramesDenial,
  type BrowserFramesHost,
  type BrowserFramesPresentResult,
  type BrowserFramesSessionRef,
  type BrowserFramesView,
  type BrowserFramesViewState,
} from "@t3tools/extension-sdk/catalogue";
import { validateContext } from "@t3tools/extension-sdk/contracts";
import { environmentEndpointUrl } from "@t3tools/client-runtime/environment";
import { deriveWsBaseUrl } from "@t3tools/shared/advertisedEndpoint";
import {
  createBrowserFrameClient,
  type BrowserFrameClient,
  type BrowserFrameEvents,
  type BrowserFrameTarget,
} from "@t3tools/client-runtime/browser-frames/stream";
import type { BrowserFrameAccess } from "@t3tools/client-runtime/browser-frames/access";

import { EnvironmentId } from "@t3tools/contracts";

import { readPreparedConnection } from "~/state/session";

export interface BrowserFramesBinding {
  /** The installation's grant set — checked on every present. */
  readonly grants: {
    readonly capabilities: readonly string[];
    readonly projectIds: readonly string[];
  };
  /** Aborting detaches every view the installation presented. */
  readonly lifetime: AbortSignal;
}

/** Seams the tests substitute; production defaults hit the real stores/DOM. */
export interface BrowserFramesBridgeDeps {
  readonly httpBaseUrl: () => string | null;
  readonly createClient: (
    target: BrowserFrameTarget,
    events: BrowserFrameEvents,
  ) => BrowserFrameClient;
  /** Latest-wins scheduler for pointer-move coalescing — returns a cancel. */
  readonly schedule: (flush: () => void) => () => void;
}

const deny = (
  reason: BrowserFramesDenial["reason"],
  detail: string,
  grant?: string,
): BrowserFramesPresentResult => ({
  ok: false,
  denial: { reason, detail, ...(grant === undefined ? {} : { grant }) },
});

const defaultSchedule = (flush: () => void) => {
  if (typeof requestAnimationFrame === "function") {
    const id = requestAnimationFrame(flush);
    return () => cancelAnimationFrame(id);
  }
  const id = setTimeout(flush, 16);
  return () => clearTimeout(id);
};

const POINTER_BUTTONS = ["left", "middle", "right"] as const;
const KEY_MODIFIERS = ["Alt", "Control", "Meta", "Shift"] as const;

const frameAccess = (httpBaseUrl: string): BrowserFrameAccess => ({
  httpBase: environmentEndpointUrl(httpBaseUrl, "/api/browser-frames"),
  wsBase: environmentEndpointUrl(deriveWsBaseUrl(httpBaseUrl), "/api/browser-frames"),
  // The lease-bound tickets are the credentials — no session cookie or
  // wsTicket is asserted for extension viewers.
  query: {},
  credentials: false,
});

const normalizedPoint = (frame: HTMLElement, clientX: number, clientY: number) => {
  const rect = frame.getBoundingClientRect();
  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
};

export function createBrowserFramesBridge(
  environmentId: string,
  overrides: Partial<BrowserFramesBridgeDeps> = {},
): (binding: BrowserFramesBinding) => BrowserFramesHost {
  const deps: BrowserFramesBridgeDeps = {
    httpBaseUrl: () =>
      readPreparedConnection(EnvironmentId.make(environmentId))?.httpBaseUrl ?? null,
    createClient: (target, events) => createBrowserFrameClient(target, {}, events),
    schedule: defaultSchedule,
    ...overrides,
  };

  return (binding) => {
    const views = new Set<() => void>();
    binding.lifetime.addEventListener(
      "abort",
      () => {
        for (const detach of views) detach();
      },
      { once: true },
    );

    return {
      id: BROWSER_FRAMES,
      version: BROWSER_FRAMES_VERSION,
      present(request): BrowserFramesPresentResult {
        if (binding.lifetime.aborted)
          return deny("host-unavailable", "the installation's client lifetime has already ended.");
        for (const grant of [BROWSER_SESSIONS, BROWSER_FRAMES])
          if (!binding.grants.capabilities.includes(grant))
            return deny(
              "grant-denied",
              `${BROWSER_FRAMES} presentation requires the ${grant} installation grant.`,
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
        if (resource.environmentId !== environmentId || !resource.threadId)
          return deny(
            "scope-invalid",
            `${BROWSER_FRAMES} requires a thread-scoped context in this environment.`,
          );
        const session = request.session;
        if (
          typeof session?.tabId !== "string" ||
          !session.tabId ||
          session.tabId.length > 128 ||
          typeof session.serverEpoch !== "string" ||
          !session.serverEpoch ||
          session.serverEpoch.length > 128
        )
          return deny(
            "session-invalid",
            "session identity must come from t3.browser/sessions (tabId + serverEpoch).",
          );
        if (request.signal?.aborted)
          return deny("scope-invalid", "the calling view's lifetime has already ended.");
        if (typeof HTMLElement === "undefined" || !(request.slot instanceof HTMLElement))
          return deny("scope-invalid", "the frame presenter requires an element to mount on.");
        const httpBaseUrl = deps.httpBaseUrl();
        if (httpBaseUrl === null)
          return deny(
            "host-unavailable",
            "this environment is not connected; remote frames need its endpoint.",
          );

        return presentRemoteFrames(
          deps,
          request,
          session,
          resource.environmentId,
          resource.threadId,
          httpBaseUrl,
          views,
        );
      },
    };
  };
}

function presentRemoteFrames(
  deps: BrowserFramesBridgeDeps,
  request: Parameters<BrowserFramesHost["present"]>[0],
  session: BrowserFramesSessionRef,
  environmentId: string,
  threadId: string,
  httpBaseUrl: string,
  views: Set<() => void>,
): BrowserFramesPresentResult {
  const document = request.slot.ownerDocument;
  const wrapper = document.createElement("div");
  wrapper.tabIndex = 0;
  wrapper.setAttribute("data-browser-frames-view", "");
  wrapper.style.cssText =
    "position:absolute;inset:0;overflow:hidden;outline:none;display:flex;align-items:center;justify-content:center;background:var(--background,#000)";
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "max-width:100%;max-height:100%;display:block";
  wrapper.appendChild(canvas);
  request.slot.appendChild(wrapper);
  // Pointer/wheel coordinates normalize against the painted frame, which
  // letterboxes inside the wrapper — not the wrapper itself.
  let frameEl: HTMLElement = canvas;

  let state: BrowserFramesViewState = {
    status: "connecting",
    inputConnected: false,
    droppedFrames: 0,
    rejectedInput: 0,
  };
  const listeners = new Set<(next: BrowserFramesViewState) => void>();
  const emit = (patch: Partial<BrowserFramesViewState>) => {
    if (detached) return;
    state = { ...state, ...patch };
    for (const listener of listeners) {
      try {
        listener(state);
      } catch {
        /* A failing caller listener must not break the transition. */
      }
    }
  };

  let detached = false;
  let client: BrowserFrameClient | null = null;
  let reminting = false;
  const access = frameAccess(httpBaseUrl);
  const minted = { ticket: null as string | null };
  const target: BrowserFrameTarget = {
    access,
    session: {
      environmentId,
      threadId,
      serverEpoch: session.serverEpoch,
      tabId: session.tabId,
    },
    get frameTicket() {
      return minted.ticket;
    },
    ...(request.openInput !== undefined ? { openInput: request.openInput } : {}),
  };

  const remintAndRestart = () => {
    if (reminting || detached) return;
    reminting = true;
    void request
      .openStream()
      .then((mint) => {
        reminting = false;
        if (detached || mint === null) return;
        minted.ticket = mint.ticket;
        client?.start();
      })
      .catch(() => {
        reminting = false;
      });
  };

  const events: BrowserFrameEvents = {
    onStatus: (status, detail) => emit({ status, ...(detail === undefined ? {} : { detail }) }),
    onConfig: () => {},
    onDropped: (dropped) => emit({ droppedFrames: dropped }),
    onUnauthorized: () => {
      client?.stop();
      remintAndRestart();
    },
    onInputConnected: (connected, detail) =>
      emit({ inputConnected: connected, ...(detail === undefined ? {} : { detail }) }),
    onInputRejected: () => emit({ rejectedInput: state.rejectedInput + 1 }),
    onMjpegFallback: () => {
      // Canvas decode is unavailable — swap to an <img> element; the client
      // drives `src` itself once the surface switches.
      const image = document.createElement("img");
      image.style.cssText = "max-width:100%;max-height:100%;display:block";
      image.alt = "";
      wrapper.replaceChild(image, canvas);
      frameEl = image;
      client?.setSurface({ image });
    },
  };
  client = deps.createClient(target, events);
  client.setSurface({ canvas });

  // ------------------------------------------------------------ DOM input
  // Pointer/wheel/key events normalize against the painted frame and ride
  // the input lane; the client gates packets until the hub binds the lease.
  let pointerDown = false;
  let pendingMove: { x: number; y: number } | null = null;
  let cancelMove: (() => void) | null = null;
  const flushMove = () => {
    cancelMove = null;
    const move = pendingMove;
    pendingMove = null;
    if (move) client?.sendPointer("move", move.x, move.y);
  };
  const onPointerMove = (event: PointerEvent) => {
    pendingMove = normalizedPoint(frameEl, event.clientX, event.clientY);
    if (cancelMove === null) cancelMove = deps.schedule(flushMove);
  };
  const onPointerDown = (event: PointerEvent) => {
    wrapper.setPointerCapture(event.pointerId);
    wrapper.focus();
    pointerDown = true;
    const { x, y } = normalizedPoint(frameEl, event.clientX, event.clientY);
    client?.sendPointer("down", x, y, POINTER_BUTTONS[event.button] ?? "left");
  };
  const onPointerUp = (event: PointerEvent) => {
    if (!pointerDown) return;
    pointerDown = false;
    const { x, y } = normalizedPoint(frameEl, event.clientX, event.clientY);
    client?.sendPointer("up", x, y, POINTER_BUTTONS[event.button] ?? "left");
  };
  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    const { x, y } = normalizedPoint(frameEl, event.clientX, event.clientY);
    client?.sendWheel(event.deltaX, event.deltaY, x, y);
  };
  const onContextMenu = (event: Event) => event.preventDefault();
  const keyModifiers = (event: KeyboardEvent) =>
    KEY_MODIFIERS.filter((name) => event.getModifierState(name));
  const onKeyDown = (event: KeyboardEvent) => {
    // Host-reserved meta combos stay local; everything else is the guest's.
    if (event.metaKey && !["r", "R"].includes(event.key)) return;
    event.preventDefault();
    client?.sendKey("down", {
      key: event.key,
      code: event.code,
      ...(event.key.length === 1 && !event.ctrlKey && !event.metaKey ? { text: event.key } : {}),
      modifiers: keyModifiers(event),
    });
  };
  const onKeyUp = (event: KeyboardEvent) => {
    if (event.metaKey && !["r", "R"].includes(event.key)) return;
    event.preventDefault();
    client?.sendKey("up", { key: event.key, code: event.code, modifiers: keyModifiers(event) });
  };
  wrapper.addEventListener("pointermove", onPointerMove);
  wrapper.addEventListener("pointerdown", onPointerDown);
  wrapper.addEventListener("pointerup", onPointerUp);
  wrapper.addEventListener("pointercancel", onPointerUp);
  wrapper.addEventListener("wheel", onWheel, { passive: false });
  wrapper.addEventListener("contextmenu", onContextMenu);
  wrapper.addEventListener("keydown", onKeyDown);
  wrapper.addEventListener("keyup", onKeyUp);

  const detach = () => {
    if (detached) return;
    detached = true;
    views.delete(detach);
    request.signal?.removeEventListener("abort", detach);
    if (cancelMove !== null) cancelMove();
    wrapper.removeEventListener("pointermove", onPointerMove);
    wrapper.removeEventListener("pointerdown", onPointerDown);
    wrapper.removeEventListener("pointerup", onPointerUp);
    wrapper.removeEventListener("pointercancel", onPointerUp);
    wrapper.removeEventListener("wheel", onWheel);
    wrapper.removeEventListener("contextmenu", onContextMenu);
    wrapper.removeEventListener("keydown", onKeyDown);
    wrapper.removeEventListener("keyup", onKeyUp);
    client?.stop();
    client = null;
    wrapper.remove();
    listeners.clear();
  };
  views.add(detach);
  request.signal?.addEventListener("abort", detach, { once: true });

  // The first mint may race a still-warming session list — keep connecting
  // and let the client's stream retry until the ticket path authenticates.
  void request.openStream().then((mint) => {
    if (detached) return;
    if (mint === null) {
      emit({ status: "error", detail: "Could not mint a browser frame ticket." });
      return;
    }
    minted.ticket = mint.ticket;
    client?.start();
  });

  const view: BrowserFramesView = {
    get state() {
      return state;
    },
    onDidChangeState(listener) {
      if (detached) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    detach,
  };
  return { ok: true, view };
}
