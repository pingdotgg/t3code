import { withDeviceHubQuery } from "@t3tools/client-runtime/state/deviceHubAccess";
import type { DeviceHubAccess } from "@t3tools/client-runtime/state/deviceHubAccess";
import type { DevicePlatform } from "@t3tools/contracts";

/**
 * Read-only hub endpoints the Tools drawer consumes directly: the accessibility
 * tree, the foreground app, and the event log. Everything that changes device
 * state goes through the `device.action` RPC instead, so this file never POSTs.
 */

export interface DeviceAxElement {
  readonly id: string;
  readonly label: string;
  readonly role: string;
  /** Normalized to the displayed screen: 0..1 on both axes. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DeviceAxTree {
  readonly elements: ReadonlyArray<DeviceAxElement>;
  readonly errors: ReadonlyArray<string>;
}

export interface DeviceEventLogEntry {
  readonly id: number;
  readonly timestamp: string;
  readonly kind: string;
  readonly summary: string;
}

export interface DeviceForegroundInfo {
  readonly id: string;
  readonly label?: string;
  readonly pid?: number;
  readonly isReactNative?: boolean;
}

interface Target {
  readonly access: DeviceHubAccess;
  readonly platform: DevicePlatform;
  readonly deviceId: string;
}

const vendorBase = (target: Target) =>
  `${target.access.httpBase}${target.platform === "ios" ? "/vendor/serve-sim" : "/vendor/serve-emu"}`;

const hubUrl = (target: Target, path: string, params?: Record<string, string>) => {
  const search = params ? `?${new URLSearchParams(params).toString()}` : "";
  return withDeviceHubQuery(`${vendorBase(target)}${path}${search}`, target.access);
};

const fetchJson = async (target: Target, url: string, signal?: AbortSignal): Promise<unknown> => {
  const response = await fetch(url, {
    cache: "no-store",
    credentials: target.access.credentials ? "include" : "same-origin",
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const numberOr = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const AX_ELEMENT_LIMIT = 500;

/**
 * serve-sim's helper returns the native nested tree; the root node is the
 * application covering the whole screen. Flatten it the way serve-sim's own
 * overlay does: skip nodes with the root's frame, cap the count.
 */
const flattenIosAxTree = (roots: ReadonlyArray<unknown>): ReadonlyArray<DeviceAxElement> => {
  const first = roots[0];
  const rootFrame = isRecord(first) && isRecord(first.frame) ? first.frame : null;
  const screenWidth = Math.max(1, numberOr(rootFrame?.width, 1));
  const screenHeight = Math.max(1, numberOr(rootFrame?.height, 1));
  const elements: DeviceAxElement[] = [];
  const visit = (node: unknown, path: string) => {
    if (elements.length >= AX_ELEMENT_LIMIT || !isRecord(node) || !isRecord(node.frame)) return;
    const frame = node.frame;
    const width = numberOr(frame.width, 0);
    const height = numberOr(frame.height, 0);
    const coversScreen =
      Math.abs(width - screenWidth) < 0.5 && Math.abs(height - screenHeight) < 0.5;
    if (!coversScreen && width > 0 && height > 0) {
      elements.push({
        id: typeof node.AXUniqueId === "string" ? node.AXUniqueId : path,
        label: typeof node.AXLabel === "string" ? node.AXLabel : "",
        role: typeof node.type === "string" ? node.type : "",
        x: numberOr(frame.x, 0) / screenWidth,
        y: numberOr(frame.y, 0) / screenHeight,
        width: width / screenWidth,
        height: height / screenHeight,
      });
    }
    const children = Array.isArray(node.children) ? node.children : [];
    children.forEach((child, index) => visit(child, `${path}.${index}`));
  };
  roots.forEach((root, index) => visit(root, String(index)));
  return elements;
};

export async function fetchDeviceAxTree(
  target: Target,
  signal?: AbortSignal,
): Promise<DeviceAxTree> {
  if (target.platform === "ios") {
    const payload = await fetchJson(
      target,
      hubUrl(target, `/helper/${encodeURIComponent(target.deviceId)}/ax`),
      signal,
    );
    if (!Array.isArray(payload)) {
      const error = isRecord(payload) && typeof payload.error === "string" ? payload.error : null;
      return { elements: [], errors: [error ?? "Unexpected accessibility payload."] };
    }
    return { elements: flattenIosAxTree(payload), errors: [] };
  }
  const payload = await fetchJson(
    target,
    hubUrl(target, "/api/accessibility", { device: target.deviceId }),
    signal,
  );
  if (!isRecord(payload) || !Array.isArray(payload.nodes)) {
    const error = isRecord(payload) && typeof payload.error === "string" ? payload.error : null;
    return { elements: [], errors: [error ?? "Unexpected accessibility payload."] };
  }
  // uiautomator reports pixel bounds; the first node is the full window.
  const nodes = payload.nodes.filter(
    (node): node is Record<string, unknown> => isRecord(node) && isRecord(node.bounds),
  );
  const root = nodes[0]?.bounds as Record<string, unknown> | undefined;
  const screenWidth = Math.max(1, numberOr(root?.right, 1));
  const screenHeight = Math.max(1, numberOr(root?.bottom, 1));
  // Layout containers span the whole window and would tint the entire
  // screen; only nodes a user could point at are worth drawing.
  const elements = nodes.slice(1).flatMap((node): DeviceAxElement[] => {
    const bounds = node.bounds as Record<string, unknown>;
    const left = numberOr(bounds.left, 0);
    const top = numberOr(bounds.top, 0);
    const width = (numberOr(bounds.right, left) - left) / screenWidth;
    const height = (numberOr(bounds.bottom, top) - top) / screenHeight;
    const text = typeof node.text === "string" ? node.text : "";
    const description = typeof node.contentDescription === "string" ? node.contentDescription : "";
    const label = text || description;
    if (width >= 0.95 && height >= 0.9) return [];
    if (!label && node.clickable !== true) return [];
    const className = typeof node.className === "string" ? node.className : "";
    return [
      {
        id: String(node.id ?? ""),
        label,
        role: className.split(".").at(-1) ?? "",
        x: left / screenWidth,
        y: top / screenHeight,
        width,
        height,
      },
    ];
  });
  return { elements, errors: [] };
}

const openEventSource = (
  target: Target,
  url: string,
  onMessage: (data: unknown) => void,
): (() => void) => {
  const source = new EventSource(url, { withCredentials: target.access.credentials });
  source.addEventListener("message", (event) => {
    try {
      onMessage(JSON.parse(String(event.data)));
    } catch {
      // Keep-alive comments and malformed frames carry nothing to render.
    }
  });
  return () => source.close();
};

/** iOS only: the frontmost app, pushed by serve-sim whenever it changes. */
export function subscribeDeviceForeground(
  target: Target,
  onChange: (app: DeviceForegroundInfo | null) => void,
): () => void {
  if (target.platform !== "ios") return () => {};
  return openEventSource(
    target,
    hubUrl(target, "/appstate", { device: target.deviceId }),
    (data) => {
      if (!isRecord(data)) return;
      if (data.bundleId === null || data.bundleId === "") {
        onChange(null);
        return;
      }
      if (typeof data.bundleId !== "string") return;
      onChange({
        id: data.bundleId,
        ...(typeof data.pid === "number" ? { pid: data.pid } : {}),
        ...(typeof data.isReactNative === "boolean" ? { isReactNative: data.isReactNative } : {}),
      });
    },
  );
}

const toEventLogEntry = (raw: unknown): DeviceEventLogEntry | null => {
  if (!isRecord(raw) || typeof raw.id !== "number") return null;
  return {
    id: raw.id,
    timestamp: typeof raw.timestamp === "string" ? raw.timestamp : "",
    kind: typeof raw.kind === "string" ? raw.kind : "",
    summary:
      typeof raw.summary === "string" ? raw.summary : typeof raw.msg === "string" ? raw.msg : "",
  };
};

/**
 * iOS only: serve-sim's event log, seeded with recent history and then pushed
 * live. Android's session recorder only tracks replayable gestures, which the
 * user already sees themselves, so it is not surfaced.
 */
export function subscribeDeviceEventLog(
  target: Target,
  onEvents: (entries: ReadonlyArray<DeviceEventLogEntry>, reset: boolean) => void,
): () => void {
  if (target.platform !== "ios") return () => {};
  return openEventSource(
    target,
    hubUrl(target, "/api/event-log/events", { device: target.deviceId, limit: "100" }),
    (data) => {
      if (!isRecord(data)) return;
      if (Array.isArray(data.events)) {
        onEvents(
          data.events.flatMap((raw) => toEventLogEntry(raw) ?? []),
          true,
        );
        return;
      }
      const entry = toEventLogEntry(data.event);
      if (entry) onEvents([entry], false);
    },
  );
}
