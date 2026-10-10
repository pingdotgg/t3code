// @effect-diagnostics globalTimers:off globalFetch:off - This browser and WebView transport runs without an Effect runtime.
import { type DeviceHubAccess, withDeviceHubQuery } from "../device/hubAccess.ts";
import {
  PREVIEW_STREAM_HOST_SETUP_CLOSE_CODE,
  type PreviewStreamHostSetup,
  type PreviewViewportSetting,
} from "@t3tools/contracts";

export const PREVIEW_STREAM_BASE_PATH = "/api/preview-stream";

export interface PreviewStreamViewport {
  readonly width: number;
  readonly height: number;
}

export type PreviewStreamMouseButton = "none" | "left" | "middle" | "right";

export interface PreviewStreamControl {
  readonly canOperate: boolean;
  readonly controller: "agent" | "you" | "another-viewer" | "unclaimed";
  readonly generation: number;
  readonly dialog: null | {
    readonly type: string;
    readonly message: string;
    readonly defaultValue: string;
  };
}

/** Status line shown above a viewer; `null` control means the socket is not connected. */
export const previewStreamControlLabel = (control: PreviewStreamControl | null): string =>
  !control
    ? "Connecting..."
    : !control.canOperate
      ? "Read-only"
      : control.controller === "you"
        ? "You have control"
        : control.controller === "agent"
          ? "Agent has control"
          : control.controller === "another-viewer"
            ? "Another viewer has control"
            : "Watching";

const isPreviewStreamDialog = (value: unknown): value is PreviewStreamControl["dialog"] =>
  value === null ||
  (typeof value === "object" &&
    "type" in value &&
    typeof value.type === "string" &&
    "message" in value &&
    typeof value.message === "string" &&
    "defaultValue" in value &&
    typeof value.defaultValue === "string");

/** Client-to-server messages. Coordinates are page CSS px. */
export type PreviewStreamInput =
  | { readonly type: "takeControl" }
  | { readonly type: "releaseControl" }
  | { readonly type: "dialog"; readonly accept: boolean; readonly promptText?: string }
  | { readonly type: "viewport"; readonly setting: PreviewViewportSetting }
  | {
      readonly type: "mouse";
      readonly action: "move" | "down" | "up";
      readonly x: number;
      readonly y: number;
      readonly button: PreviewStreamMouseButton;
      /** Pressed buttons: left 1, right 2, middle 4. */
      readonly buttons: number;
      readonly clickCount: number;
      readonly modifiers: number;
    }
  | {
      readonly type: "wheel";
      readonly x: number;
      readonly y: number;
      readonly deltaX: number;
      readonly deltaY: number;
      readonly modifiers: number;
    }
  | {
      readonly type: "key";
      readonly action: "down" | "up";
      readonly key: string;
      readonly code: string;
      /** Windows virtual key code (DOM `keyCode`); Enter, Backspace, and arrows need it. */
      readonly keyCode?: number;
      /** Only for printable keys without Ctrl or Meta. */
      readonly text?: string;
      readonly modifiers: number;
    }
  | { readonly type: "text"; readonly text: string }
  /**
   * A saved login from the viewer's AutoFill, for the page only while it is on
   * `origin`, the site the viewer confirmed. A focused password field gets the
   * password; another field gets the username, then Tab, then the password only
   * if Tab reached a password field. A field in a cross-origin frame gets nothing.
   */
  | {
      readonly type: "fillLogin";
      readonly origin: string;
      readonly username: string;
      readonly password: string;
    }
  /** Answer to a `passkey` request (see `PreviewStreamTarget.passkeys`). */
  | {
      readonly type: "passkeyResult";
      readonly id: string;
      readonly result: PreviewStreamPasskeyResult;
    }
  | { readonly type: "resize"; readonly width: number; readonly height: number }
  | { readonly type: "navigate"; readonly url: string }
  | { readonly type: "history"; readonly delta: -1 | 1 }
  | { readonly type: "reload"; readonly ignoreCache?: boolean }
  /** Asks whether the page point takes text. Touch viewers send it on touch start. */
  | { readonly type: "probe"; readonly x: number; readonly y: number };

export interface PreviewStreamDownload {
  readonly fileName: string;
  readonly sizeBytes: number;
  /** Authenticated with the stream's own access; cookie sessions must send credentials. */
  readonly url: string;
}

export interface PreviewStreamFileChooser {
  readonly multiple: boolean;
  /** The input's `accept` attribute, ready for a local `<input type=file>`. */
  readonly accept: string;
  /** POST multipart `file` parts here; an empty form cancels the page's picker. */
  readonly uploadUrl: string;
  /** Cookie sessions must send credentials with the upload. */
  readonly credentials: boolean;
}

const previewStreamUploadUrl = (
  target: Pick<PreviewStreamTarget, "access" | "threadId" | "tabId">,
  chooser: string,
): string =>
  withDeviceHubQuery(
    `${target.access.httpBase}/upload?${new URLSearchParams({
      threadId: target.threadId,
      tabId: target.tabId,
      chooser,
    }).toString()}`,
    target.access,
  );

/** Sends files to a page's open picker. Rejects when the server refuses them. */
export async function uploadPreviewStreamFiles(
  chooser: PreviewStreamFileChooser,
  files: ReadonlyArray<Blob & { readonly name?: string }>,
): Promise<void> {
  const body = new FormData();
  for (const file of files) body.append("file", file, file.name ?? "file");
  const response = await fetch(chooser.uploadUrl, {
    method: "POST",
    body,
    credentials: chooser.credentials ? "include" : "omit",
  });
  if (!response.ok) throw new Error((await response.text()) || "The upload was refused.");
}

/** A file a server tab downloaded, served with the stream's own access. */
export const previewStreamDownloadUrl = (
  target: Pick<PreviewStreamTarget, "access" | "threadId" | "tabId">,
  id: string,
): string =>
  withDeviceHubQuery(
    `${target.access.httpBase}/download?${new URLSearchParams({
      threadId: target.threadId,
      tabId: target.tabId,
      id,
    }).toString()}`,
    target.access,
  );

/**
 * A page's WebAuthn request, for the controlling viewer's own passkeys. The
 * server has checked the origin and RP ID. Binary members are base64url, as in
 * WebAuthn's JSON forms of the options.
 */
export interface PreviewStreamPasskeyRequest {
  readonly id: string;
  readonly kind: "create" | "get";
  /** The page's origin, as the server's browser reports it, never as the page claims it. */
  readonly origin: string;
  /** `PublicKeyCredentialCreationOptionsJSON` or `PublicKeyCredentialRequestOptionsJSON`. */
  readonly publicKey: Readonly<Record<string, unknown>>;
}

/** What the device's authenticator returned, base64url throughout. */
export interface PreviewStreamPasskeyCredential {
  readonly id: string;
  readonly clientDataJSON: string;
  /** Registrations only. */
  readonly attestationObject?: string;
  /** Assertions only. */
  readonly authenticatorData?: string;
  readonly signature?: string;
  readonly userHandle?: string;
  readonly authenticatorAttachment?: "platform" | "cross-platform";
  readonly transports?: ReadonlyArray<string>;
}

export type PreviewStreamPasskeyResult =
  | { readonly success: true; readonly credential: PreviewStreamPasskeyCredential }
  /** A WebAuthn DOMException name, such as `NotAllowedError`. */
  | { readonly success: false; readonly error: string };

/** Answer to a `probe`, echoing its point. */
export interface PreviewStreamProbe {
  readonly x: number;
  readonly y: number;
  readonly editable: boolean;
}

/** Where an agent action is about to land, in page CSS pixels. */
export interface PreviewStreamPointer {
  readonly phase: "move" | "click";
  readonly x: number;
  readonly y: number;
  readonly sequence: number;
}

/** CDP modifier bitmask: Alt 1, Ctrl 2, Meta 4, Shift 8. */
export const previewStreamModifiers = (event: {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}): number =>
  (event.altKey ? 1 : 0) |
  (event.ctrlKey ? 2 : 0) |
  (event.metaKey ? 4 : 0) |
  (event.shiftKey ? 8 : 0);

export interface PreviewStreamTarget {
  readonly access: DeviceHubAccess;
  readonly threadId: string;
  readonly tabId: string;
  /** Viewer backing-store size in device px. The server never sends larger frames. */
  readonly maxWidth: number;
  readonly maxHeight: number;
  /** Passive viewers reduce their own access, including automatic control grants. */
  readonly interactive?: boolean;
  /** This device answers the page's passkey requests while it has control. */
  readonly passkeys?: boolean;
}

export interface PreviewStreamEvents {
  /** One complete JPEG frame. */
  readonly onFrame: (jpeg: ArrayBuffer) => void;
  readonly onViewport: (viewport: PreviewStreamViewport) => void;
  readonly onProbe?: (probe: PreviewStreamProbe) => void;
  /** The agent's cursor moved to, or clicked at, a page point. */
  readonly onPointer?: (pointer: PreviewStreamPointer) => void;
  readonly onControl?: (control: PreviewStreamControl) => void;
  /** Text the page just copied or cut while this viewer had control. */
  readonly onClipboard?: (text: string) => void;
  /** A file the page downloaded while this viewer had control. */
  readonly onDownload?: (download: PreviewStreamDownload) => void;
  /** The page this viewer controls opened a new tab (a link or `window.open`). */
  readonly onPopup?: (tabId: string) => void;
  /** The page opened a file picker (`null` once answered or replaced). */
  readonly onFileChooser?: (chooser: PreviewStreamFileChooser | null) => void;
  /** The page asked for a passkey; answer with a `passkeyResult` input. */
  readonly onPasskey?: (request: PreviewStreamPasskeyRequest) => void;
  /** The page gave up on a passkey request: it aborted, timed out, navigated, or control moved. */
  readonly onPasskeyCancel?: (id: string) => void;
  /** Input sent while disconnected is dropped. */
  readonly onConnectedChange: (connected: boolean) => void;
  /** The upgrade was refused; refresh access and start a new client. */
  readonly onUnauthorized: () => void;
  /** The tab was closed on the server. The client has stopped. */
  readonly onGone?: () => void;
  /** The server's browser cannot start until its host is set up. The client has stopped. */
  readonly onHostSetup?: (setup: PreviewStreamHostSetup) => void;
}

export interface PreviewStreamClient {
  /** False when the socket is not open and the message was dropped. */
  readonly send: (input: PreviewStreamInput) => boolean;
  readonly stop: () => void;
}

const ACK_MESSAGE = JSON.stringify({ type: "ack" });
export function createPreviewStreamClient(
  target: PreviewStreamTarget,
  events: PreviewStreamEvents,
): PreviewStreamClient {
  const query = new URLSearchParams({
    threadId: target.threadId,
    tabId: target.tabId,
    maxWidth: String(Math.max(1, Math.round(target.maxWidth))),
    maxHeight: String(Math.max(1, Math.round(target.maxHeight))),
  });
  if (target.interactive === false) query.set("interactive", "false");
  if (target.passkeys) query.set("passkeys", "true");
  const url = withDeviceHubQuery(`${target.access.wsBase}/ws?${query.toString()}`, target.access);
  let stopped = false;
  let socket: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  let control: PreviewStreamControl | null = null;
  let fileChooser: string | null = null;

  const connect = () => {
    if (stopped) return;
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    socket = ws;
    let opened = false;
    ws.addEventListener("open", () => {
      if (socket !== ws) return;
      opened = true;
      events.onConnectedChange(true);
    });
    ws.addEventListener("message", (event) => {
      if (socket !== ws) return;
      if (event.data instanceof ArrayBuffer) {
        failures = 0;
        ws.send(ACK_MESSAGE);
        events.onFrame(event.data);
        return;
      }
      if (typeof event.data !== "string") return;
      let message: unknown;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (typeof message !== "object" || message === null) return;
      const {
        type,
        x,
        y,
        width,
        height,
        editable,
        canOperate,
        controller,
        generation,
        dialog,
        text,
        id,
        fileName,
        sizeBytes,
        multiple,
        accept,
        phase,
        sequence,
        tabId,
        kind,
        origin,
        publicKey,
      } = message as Record<string, unknown>;
      if (
        type === "passkey" &&
        typeof id === "string" &&
        (kind === "create" || kind === "get") &&
        typeof origin === "string" &&
        typeof publicKey === "object" &&
        publicKey !== null
      ) {
        events.onPasskey?.({
          id,
          kind,
          origin,
          publicKey: publicKey as Readonly<Record<string, unknown>>,
        });
      } else if (type === "passkeyCancel" && typeof id === "string") {
        events.onPasskeyCancel?.(id);
      } else if (
        type === "fileChooser" &&
        typeof id === "string" &&
        typeof multiple === "boolean" &&
        typeof accept === "string"
      ) {
        fileChooser = id;
        events.onFileChooser?.({
          multiple,
          accept,
          uploadUrl: previewStreamUploadUrl(target, id),
          credentials: target.access.credentials,
        });
      } else if (type === "fileChooserClosed" && typeof id === "string") {
        if (fileChooser !== id) return;
        fileChooser = null;
        events.onFileChooser?.(null);
      } else if (
        type === "pointer" &&
        (phase === "move" || phase === "click") &&
        typeof x === "number" &&
        typeof y === "number" &&
        typeof sequence === "number"
      ) {
        events.onPointer?.({ phase, x, y, sequence });
      } else if (type === "popup" && typeof tabId === "string") {
        events.onPopup?.(tabId);
      } else if (type === "clipboard" && typeof text === "string") {
        events.onClipboard?.(text);
      } else if (
        type === "download" &&
        typeof id === "string" &&
        typeof fileName === "string" &&
        typeof sizeBytes === "number"
      ) {
        events.onDownload?.({
          fileName,
          sizeBytes,
          url: previewStreamDownloadUrl(target, id),
        });
      } else if (type === "viewport" && typeof width === "number" && typeof height === "number") {
        failures = 0;
        events.onViewport({ width, height });
      } else if (
        type === "probe" &&
        typeof x === "number" &&
        typeof y === "number" &&
        typeof editable === "boolean"
      ) {
        events.onProbe?.({ x, y, editable });
      } else if (
        type === "control" &&
        typeof canOperate === "boolean" &&
        (controller === "agent" ||
          controller === "you" ||
          controller === "another-viewer" ||
          controller === "unclaimed") &&
        typeof generation === "number" &&
        isPreviewStreamDialog(dialog)
      ) {
        const nextControl: PreviewStreamControl = {
          canOperate,
          controller,
          generation,
          dialog,
        };
        control = nextControl;
        events.onControl?.(nextControl);
      }
    });
    ws.addEventListener("close", (event) => {
      if (socket !== ws) return;
      socket = null;
      control = null;
      if (opened) events.onConnectedChange(false);
      if (stopped) return;
      if (event.code === 4404) {
        stopped = true;
        events.onGone?.();
        return;
      }
      if (event.code === PREVIEW_STREAM_HOST_SETUP_CLOSE_CODE) {
        stopped = true;
        events.onHostSetup?.(decodeHostSetup(event.reason));
        return;
      }
      // Rejected upgrades surface as 1006 before open for both cookies and tickets.
      if (event.code === 1008 || event.code === 4401 || (!opened && event.code === 1006)) {
        stopped = true;
        events.onUnauthorized();
        return;
      }
      retryTimer = setTimeout(connect, Math.min(500 * 2 ** failures++, 10_000));
    });
    ws.addEventListener("error", () => ws.close());
  };

  connect();

  return {
    send: (input) => {
      if (socket?.readyState !== WebSocket.OPEN) return false;
      if (!control?.canOperate) return false;
      if (input.type !== "takeControl" && control.controller !== "you") return false;
      socket.send(JSON.stringify(input));
      return true;
    },
    stop: () => {
      stopped = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      const ws = socket;
      socket = null;
      control = null;
      ws?.close();
    },
  };
}

export interface PreviewFramePainter {
  readonly paint: (jpeg: ArrayBuffer) => void;
  readonly stop: () => void;
}

/** One decode at a time, keeping only the latest waiting frame for slow viewers. */
export function createPreviewFramePainter(
  canvas: HTMLCanvasElement,
  onPainted?: () => void,
): PreviewFramePainter {
  const context = canvas.getContext("2d");
  let stopped = false;
  let decoding = false;
  let waiting: ArrayBuffer | null = null;
  const draw = (jpeg: ArrayBuffer) => {
    decoding = true;
    void createImageBitmap(new Blob([jpeg], { type: "image/jpeg" }))
      .then((bitmap) => {
        if (stopped || !context) {
          bitmap.close();
          return;
        }
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
        }
        context.drawImage(bitmap, 0, 0);
        bitmap.close();
        onPainted?.();
      })
      // A frame that fails to decode is skipped; the next one repaints.
      .catch(() => undefined)
      .finally(() => {
        decoding = false;
        const next = waiting;
        waiting = null;
        if (next && !stopped) draw(next);
      });
  };
  return {
    paint: (jpeg) => {
      if (stopped) return;
      if (decoding) waiting = jpeg;
      else draw(jpeg);
    },
    stop: () => {
      stopped = true;
      waiting = null;
    },
  };
}

/** A malformed reason still stops the viewer and offers the usual command. */
const decodeHostSetup = (reason: string): PreviewStreamHostSetup => {
  try {
    const value = JSON.parse(reason) as Partial<PreviewStreamHostSetup>;
    if (
      (value.need === "sandbox" || value.need === "libraries") &&
      typeof value.command === "string"
    ) {
      return { need: value.need, command: value.command };
    }
  } catch {}
  return { need: "sandbox", command: "sudo npx t3 browser setup" };
};

/** What a viewer tells the person; `command` is shown beside it, ready to copy. */
export const previewStreamHostSetupMessage = (setup: PreviewStreamHostSetup) =>
  setup.need === "sandbox"
    ? "This server's host blocks the sandbox its browser runs in. Run this once on the host, then try again:"
    : "This server's host is missing libraries its browser needs. Run this once on the host, then try again:";
