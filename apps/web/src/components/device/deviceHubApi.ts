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
    if (!isRecord(payload) || !Array.isArray(payload.elements)) {
      return { elements: [], errors: ["Unexpected accessibility payload."] };
    }
    const screen = isRecord(payload.screen) ? payload.screen : {};
    const screenWidth = Math.max(1, numberOr(screen.width, 1));
    const screenHeight = Math.max(1, numberOr(screen.height, 1));
    const elements = payload.elements.flatMap((raw): DeviceAxElement[] => {
      if (!isRecord(raw) || !isRecord(raw.frame)) return [];
      const frame = raw.frame;
      return [
        {
          id: String(raw.id ?? raw.path ?? ""),
          label: typeof raw.label === "string" ? raw.label : "",
          role: typeof raw.role === "string" ? raw.role : "",
          x: numberOr(frame.x, 0) / screenWidth,
          y: numberOr(frame.y, 0) / screenHeight,
          width: numberOr(frame.width, 0) / screenWidth,
          height: numberOr(frame.height, 0) / screenHeight,
        },
      ];
    });
    const errors = Array.isArray(payload.errors) ? payload.errors.map(String) : [];
    return { elements, errors };
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
  const elements = nodes.slice(1).map((node): DeviceAxElement => {
    const bounds = node.bounds as Record<string, unknown>;
    const left = numberOr(bounds.left, 0);
    const top = numberOr(bounds.top, 0);
    const text = typeof node.text === "string" ? node.text : "";
    const description = typeof node.contentDescription === "string" ? node.contentDescription : "";
    const className = typeof node.className === "string" ? node.className : "";
    return {
      id: String(node.id ?? ""),
      label: text || description,
      role: className.split(".").at(-1) ?? "",
      x: left / screenWidth,
      y: top / screenHeight,
      width: (numberOr(bounds.right, left) - left) / screenWidth,
      height: (numberOr(bounds.bottom, top) - top) / screenHeight,
    };
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
      if (!isRecord(data) || typeof data.bundleId !== "string") return;
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
