// @effect-diagnostics globalTimers:off globalDate:off -- Runs in plain browser and React Native code, with a DOM timer for the fetch deadline and wall time for the link rate limit.
import type { AssetResource, OrchestrationV2MessageArtifact } from "@t3tools/contracts";
import {
  findMessageArtifactFences,
  type MessageArtifactFence,
} from "@t3tools/shared/messageArtifacts";

import {
  splitCodexArtifactTemplateMarkdown,
  type CodexArtifactTemplateMarkdownSegment,
} from "./codexMarkdownDirectives.ts";
import { readFilePreviewResponse } from "./filePreview.ts";

export const MESSAGE_ARTIFACT_MIN_FRAME_HEIGHT = 96;
export const MESSAGE_ARTIFACT_MAX_FRAME_HEIGHT = 720;
/** Height before an artifact reports its content, so a page sized to its frame is still usable. */
export const MESSAGE_ARTIFACT_DEFAULT_FRAME_HEIGHT = 320;

export const MESSAGE_ARTIFACT_LOAD_FAILED_MESSAGE = "The artifact could not be loaded.";
export const MESSAGE_ARTIFACT_TIMEOUT_MESSAGE = "The artifact took too long to load.";
export const MESSAGE_ARTIFACT_UNAVAILABLE_MESSAGE =
  "This artifact may be missing or unavailable on this environment.";
export const MESSAGE_ARTIFACT_NAVIGATED_MESSAGE =
  "This artifact tried to open another page, so it was stopped.";

/**
 * Artifacts use the MCP Apps theme variables, size and link messages:
 * https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
 * MCP Apps has no state API, so T3 Code adds `t3/notifications/state-changed`, and the page reports
 * `t3/notifications/unloading` when it leaves its document.
 */
const MCP_APPS_PROTOCOL_VERSION = "2026-01-26";
const STATE_CHANGED_METHOD = "t3/notifications/state-changed";
const UNLOADING_METHOD = "t3/notifications/unloading";

const STATE_MAX_FIELDS = 64;
const STATE_MAX_KEY_LENGTH = 128;
const STATE_MAX_VALUE_LENGTH = 4096;
const STATE_MAX_DATA_LENGTH = 64_000;
const FETCH_TIMEOUT_MS = 15_000;
const LINK_INTERVAL_MS = 1_000;

/** The MCP Apps theme variables T3 Code provides. */
export const MESSAGE_ARTIFACT_STYLE_VARIABLES = [
  "--color-background-primary",
  "--color-background-secondary",
  "--color-background-tertiary",
  "--color-background-inverse",
  "--color-background-info",
  "--color-background-success",
  "--color-background-warning",
  "--color-background-danger",
  "--color-text-primary",
  "--color-text-secondary",
  "--color-text-tertiary",
  "--color-text-inverse",
  "--color-text-info",
  "--color-text-success",
  "--color-text-warning",
  "--color-text-danger",
  "--color-border-primary",
  "--color-border-secondary",
  "--color-border-danger",
  "--color-ring-primary",
  "--font-sans",
  "--font-mono",
  "--font-text-sm-size",
  "--font-text-md-size",
  "--border-radius-sm",
  "--border-radius-md",
  "--border-radius-lg",
  "--border-radius-full",
] as const;
export type MessageArtifactStyleVariable = (typeof MESSAGE_ARTIFACT_STYLE_VARIABLES)[number];

/** The part of the MCP Apps `HostContext` T3 Code provides. */
export interface MessageArtifactHostContext {
  readonly theme: "light" | "dark";
  readonly platform: "web" | "desktop" | "mobile";
  readonly styles: { readonly variables: Readonly<Record<MessageArtifactStyleVariable, string>> };
  readonly containerDimensions: { readonly maxHeight: number };
}

/**
 * What an artifact asked the host to keep: its form values, and the JSON it passed to
 * `window.t3.setState`.
 */
export interface MessageArtifactState {
  readonly fields: Readonly<Record<string, string>>;
  readonly data?: string;
}

export type MessageArtifactSource =
  | { readonly _tag: "Ready"; readonly source: string }
  | { readonly _tag: "Failure"; readonly message: string };

/** A finished `t3-artifact` fence, with the attachment holding its saved copy once there is one. */
export type MessageArtifactPart = MessageArtifactFence & { readonly attachmentId: string | null };

/**
 * The `t3-artifact` fences of a finished message, each matched to the saved copy with the same
 * position and path. Streaming text has none, so its fences stay code while they change.
 */
export function messageArtifactParts(
  text: string,
  streaming: boolean,
  artifacts: ReadonlyArray<OrchestrationV2MessageArtifact> | undefined,
): MessageArtifactPart[] {
  if (streaming || !/t3-artifact/iu.test(text)) return [];
  return findMessageArtifactFences(text).map((fence) => ({
    ...fence,
    attachmentId:
      artifacts?.find(
        (entry) => entry.sourceOrdinal === fence.sourceOrdinal && entry.sourcePath === fence.path,
      )?.attachmentId ?? null,
  }));
}

export type MessageArtifactMarkdownSegment =
  | CodexArtifactTemplateMarkdownSegment
  | {
      readonly kind: "message-artifact";
      readonly sourceOffset: number;
      readonly artifact: MessageArtifactPart;
    };

/** Splits a message for native renderers, which show artifacts between markdown runs. */
export function splitMessageArtifactMarkdown(
  markdown: string,
  streaming: boolean,
  artifacts: ReadonlyArray<OrchestrationV2MessageArtifact> | undefined,
): MessageArtifactMarkdownSegment[] {
  const segments: MessageArtifactMarkdownSegment[] = [];
  let cursor = 0;
  const pushMarkdown = (end: number) => {
    for (const segment of splitCodexArtifactTemplateMarkdown(markdown.slice(cursor, end))) {
      segments.push({ ...segment, sourceOffset: cursor + segment.sourceOffset });
    }
  };
  for (const artifact of messageArtifactParts(markdown, streaming, artifacts)) {
    pushMarkdown(artifact.start);
    segments.push({ kind: "message-artifact", sourceOffset: artifact.start, artifact });
    cursor = artifact.end;
  }
  pushMarkdown(markdown.length);
  return segments;
}

export function messageArtifactFileName(path: string): string {
  return path.split(/[\\/]/u).at(-1) ?? path;
}

/** Copies are text attachments of the thread; `text/plain` is served as an inert download. */
export function messageArtifactAssetResource(
  attachmentId: string,
  fileName: string,
): AssetResource {
  return { _tag: "attachment", attachmentId, fileName, mimeType: "text/plain" };
}

/** Script for a React Native WebView that delivers a host message like `postMessage` does on web. */
export function messageArtifactMessageInjection(message: object): string {
  return `window.dispatchEvent(new MessageEvent("message",{data:${serializeForScript(message)}}));true;`;
}

interface MessageArtifactMemory {
  readonly state?: MessageArtifactState;
  readonly height?: number;
  readonly hidden?: boolean;
  /** The fetched copy. Saved copies never change, so a remount or renewed URL reuses it. */
  readonly source?: string;
}

const REMEMBERED_ARTIFACT_LIMIT = 50;
const REMEMBERED_SOURCE_LENGTH_LIMIT = 8 * 1024 * 1024;
const STORED_HEIGHT_LIMIT = 200;
const STORED_HEIGHT_WRITE_DELAY_MS = 1_000;
const rememberedArtifacts = new Map<string, MessageArtifactMemory>();

/** Where a host keeps artifact heights across restarts, as one serialized value. */
export interface MessageArtifactHeightStore {
  readonly read: () => string | null;
  readonly write: (value: string) => void;
}

let heightStore: MessageArtifactHeightStore | null = null;
let storedHeights: Map<string, number> | null = null;
let heightWriteScheduled = false;

/** Lets heights outlive the app, so a reopened thread does not jump from the default height. */
export function setMessageArtifactHeightStore(store: MessageArtifactHeightStore | null): void {
  heightStore = store;
  storedHeights = null;
}

function readStoredHeights(): Map<string, number> {
  if (storedHeights !== null) return storedHeights;
  const heights = new Map<string, number>();
  storedHeights = heights;
  try {
    const entries: unknown = JSON.parse(heightStore?.read() ?? "[]");
    if (!Array.isArray(entries)) return heights;
    for (const entry of entries.slice(-STORED_HEIGHT_LIMIT)) {
      const [key, height] = Array.isArray(entry) ? entry : [];
      if (
        typeof key === "string" &&
        typeof height === "number" &&
        height >= MESSAGE_ARTIFACT_MIN_FRAME_HEIGHT &&
        height <= MESSAGE_ARTIFACT_MAX_FRAME_HEIGHT
      ) {
        heights.set(key, height);
      }
    }
  } catch {
    // Unreadable storage starts empty.
  }
  return heights;
}

/** Most recently sized last; writes are batched so a page that animates its height stays cheap. */
function storeHeight(key: string, height: number): void {
  const heights = readStoredHeights();
  heights.delete(key);
  heights.set(key, height);
  for (const oldest of heights.keys()) {
    if (heights.size <= STORED_HEIGHT_LIMIT) break;
    heights.delete(oldest);
  }
  if (heightWriteScheduled) return;
  heightWriteScheduled = true;
  setTimeout(() => {
    heightWriteScheduled = false;
    try {
      heightStore?.write(JSON.stringify([...readStoredHeights()]));
    } catch {
      // Heights are a nicety; a full or missing store only loses them.
    }
  }, STORED_HEIGHT_WRITE_DELAY_MS);
}

/** What the host kept for an artifact, so a remount looks and behaves the same. */
export function readMessageArtifactMemory(key: string): MessageArtifactMemory | undefined {
  const memory = rememberedArtifacts.get(key);
  if (memory?.height !== undefined || heightStore === null) return memory;
  const height = readStoredHeights().get(key);
  return height === undefined ? memory : { ...memory, height };
}

/**
 * Keeps only the most recently used artifacts, and drops the oldest fetched copies past 8 MB, so a
 * long session cannot grow without bound. Heights also go to the height store.
 */
export function rememberMessageArtifact(key: string, update: MessageArtifactMemory): void {
  const next = { ...rememberedArtifacts.get(key), ...update };
  rememberedArtifacts.delete(key);
  rememberedArtifacts.set(key, next);
  for (const oldest of rememberedArtifacts.keys()) {
    if (rememberedArtifacts.size <= REMEMBERED_ARTIFACT_LIMIT) break;
    rememberedArtifacts.delete(oldest);
  }
  if (update.height !== undefined && heightStore !== null) storeHeight(key, update.height);
  if (update.source === undefined) return;
  let sourceLength = 0;
  for (const memory of rememberedArtifacts.values()) sourceLength += memory.source?.length ?? 0;
  for (const [oldestKey, { source, ...rest }] of rememberedArtifacts) {
    if (sourceLength <= REMEMBERED_SOURCE_LENGTH_LIMIT) break;
    if (source === undefined || oldestKey === key) continue;
    sourceLength -= source.length;
    rememberedArtifacts.set(oldestKey, rest);
  }
}

interface JsonRpcMessage {
  readonly id: string | number | undefined;
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
}

function readJsonRpcMessage(value: unknown): JsonRpcMessage | null {
  let message = value;
  if (typeof message === "string") {
    try {
      message = JSON.parse(message) as unknown;
    } catch {
      return null;
    }
  }
  if (message === null || typeof message !== "object") return null;
  const { jsonrpc, id, method, params } = message as Record<string, unknown>;
  if (jsonrpc !== "2.0" || typeof method !== "string") return null;
  return {
    id: typeof id === "string" || typeof id === "number" ? id : undefined,
    method,
    params:
      params !== null && typeof params === "object" ? (params as Record<string, unknown>) : {},
  };
}

/** Bounded, so a page cannot grow the host's memory through the state it reports. */
function readState(params: Readonly<Record<string, unknown>>): MessageArtifactState | null {
  const { fields, data } = params;
  if (fields === null || typeof fields !== "object" || Array.isArray(fields)) return null;
  const boundedFields = Object.fromEntries(
    Object.entries(fields as Record<string, unknown>)
      .filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === "string" &&
          entry[0].length <= STATE_MAX_KEY_LENGTH &&
          entry[1].length <= STATE_MAX_VALUE_LENGTH,
      )
      .slice(0, STATE_MAX_FIELDS),
  );
  return typeof data === "string" && data.length <= STATE_MAX_DATA_LENGTH
    ? { fields: boundedFields, data }
    : { fields: boundedFields };
}

/** Links open outside the app, and only for web addresses. */
function externalUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

export interface MessageArtifactHost {
  /** Handles a JSON-RPC message the page posted. */
  readonly receive: (data: unknown) => void;
  /** Sends a changed context once the page has finished its handshake. */
  readonly updateContext: (context: MessageArtifactHostContext) => void;
}

/**
 * The host side of the MCP Apps bridge for one artifact. It answers `ui/initialize` and `ping`,
 * applies `ui/notifications/size-changed`, passes `ui/open-link` to `openLink` at most once per
 * second, stops on `t3/notifications/unloading`, and remembers the state the page reports.
 */
export function createMessageArtifactHost(options: {
  readonly key: string;
  readonly context: MessageArtifactHostContext;
  readonly send: (message: object) => void;
  /** Receives clamped heights that moved by at least 2 px, so a jittering page cannot relayout the thread. */
  readonly onHeight: (height: number) => void;
  /** Opens a link the page asked for, and returns false when refused, e.g. without a user click. */
  readonly openLink: (url: string) => boolean | Promise<boolean>;
  /** The page is leaving its document; the artifact should stop. */
  readonly onUnload: () => void;
}): MessageArtifactHost {
  let context = options.context;
  let initialized = false;
  let height: number | null = null;
  let linkRequestedAt = Number.NEGATIVE_INFINITY;
  let linkPending = false;
  const respond = (id: string | number | undefined, outcome: object) => {
    if (id !== undefined) options.send({ jsonrpc: "2.0", id, ...outcome });
  };
  const refuseLink = (id: string | number | undefined) =>
    respond(id, { error: { code: -32000, message: "Link not opened" } });
  return {
    receive(data) {
      const message = readJsonRpcMessage(data);
      if (message === null) return;
      switch (message.method) {
        case "ui/initialize":
          respond(message.id, {
            result: {
              protocolVersion: MCP_APPS_PROTOCOL_VERSION,
              hostInfo: { name: "T3 Code", version: "1" },
              hostCapabilities: { openLinks: {} },
              hostContext: context,
            },
          });
          return;
        case "ui/notifications/initialized":
          initialized = true;
          return;
        case "ping":
          respond(message.id, { result: {} });
          return;
        case "ui/notifications/size-changed": {
          const reported = message.params.height;
          if (typeof reported !== "number" || !Number.isFinite(reported) || reported <= 0) return;
          const next = Math.min(
            MESSAGE_ARTIFACT_MAX_FRAME_HEIGHT,
            Math.max(MESSAGE_ARTIFACT_MIN_FRAME_HEIGHT, Math.ceil(reported)),
          );
          if (height !== null && Math.abs(next - height) < 2) return;
          height = next;
          options.onHeight(next);
          return;
        }
        case "ui/open-link": {
          const url = externalUrl(message.params.url);
          const now = Date.now();
          if (url === null || linkPending || now - linkRequestedAt < LINK_INTERVAL_MS) {
            refuseLink(message.id);
            return;
          }
          linkRequestedAt = now;
          const finish = (opened: boolean) => {
            linkPending = false;
            if (opened) respond(message.id, { result: {} });
            else refuseLink(message.id);
          };
          const opened = options.openLink(url);
          if (typeof opened === "boolean") {
            finish(opened);
          } else {
            linkPending = true;
            void opened.then(finish, () => finish(false));
          }
          return;
        }
        case UNLOADING_METHOD:
          options.onUnload();
          return;
        case STATE_CHANGED_METHOD: {
          const state = readState(message.params);
          if (state !== null) rememberMessageArtifact(options.key, { state });
          return;
        }
        default:
          respond(message.id, { error: { code: -32601, message: "Method not found" } });
      }
    },
    updateContext(next) {
      context = next;
      if (initialized) {
        options.send({
          jsonrpc: "2.0",
          method: "ui/notifications/host-context-changed",
          params: next,
        });
      }
    },
  };
}

/**
 * The page side of the MCP Apps bridge, run inside the web iframe and the React Native WebView
 * before the artifact's own scripts. It applies the host context, reports content height and
 * state, restores state after a remount, turns link clicks into `ui/open-link`, and reports when
 * the page leaves its document. Request ids are prefixed so they cannot collide with an MCP Apps
 * SDK running in the same page.
 */
const MESSAGE_ARTIFACT_BRIDGE_SCRIPT = String.raw`
(() => {
  const host = window.__t3ArtifactHost || {};
  let nextId = 1;
  const post = (message) => {
    message.jsonrpc = '2.0';
    if (window.parent !== window) window.parent.postMessage(message, '*');
    window.ReactNativeWebView?.postMessage(JSON.stringify(message));
  };

  const applyContext = (context) => {
    if (!context || typeof context !== 'object') return;
    if (context.theme === 'light' || context.theme === 'dark') {
      document.documentElement.style.colorScheme = context.theme;
      document.documentElement.dataset.theme = context.theme;
    }
    for (const [name, value] of Object.entries(context.styles?.variables ?? {})) {
      if (!/^--[a-z0-9-]{1,64}$/.test(name) || typeof value !== 'string' || value.length > 256) continue;
      document.documentElement.style.setProperty(name, value);
    }
  };
  applyContext(host.context);

  let previousHeight = 0;
  let sizeScheduled = false;
  const reportSize = () => {
    if (sizeScheduled) return;
    sizeScheduled = true;
    requestAnimationFrame(() => {
      sizeScheduled = false;
      const height = Math.ceil(document.documentElement.getBoundingClientRect().height);
      if (height <= 0 || height === previousHeight) return;
      previousHeight = height;
      post({ method: 'ui/notifications/size-changed', params: { width: window.innerWidth, height } });
    });
  };

  const saved = host.state || { fields: {} };
  let data = saved.data;
  const fields = () =>
    Array.from(document.querySelectorAll('input, textarea, select')).filter(
      (field) => field.type !== 'file' && field.type !== 'password',
    );
  const fieldKey = (field, index) => {
    if (field.type === 'radio' && field.name) return 'radio:' + field.name;
    if (field.type === 'checkbox' && field.name) return 'checkbox:' + field.name + ':' + field.value;
    return field.name || field.id || '#' + index;
  };
  const readField = (field) => {
    if (field.type === 'checkbox') return field.checked ? '1' : '';
    if (field.multiple) return JSON.stringify(Array.from(field.selectedOptions, (option) => option.value));
    return String(field.value ?? '');
  };
  const collectFields = () => {
    const values = {};
    fields().forEach((field, index) => {
      const key = fieldKey(field, index);
      if (field.type === 'radio') {
        if (field.checked || !(key in values)) values[key] = field.checked ? field.value : '';
      } else {
        values[key] = readField(field);
      }
    });
    return values;
  };
  let stateTimer = 0;
  const reportState = () => {
    clearTimeout(stateTimer);
    stateTimer = setTimeout(() => {
      const params = { fields: collectFields() };
      if (typeof data === 'string') params.data = data;
      post({ method: '${STATE_CHANGED_METHOD}', params });
    }, 150);
  };
  const restoreFields = () => {
    fields().forEach((field, index) => {
      const value = saved.fields[fieldKey(field, index)];
      if (value === undefined) return;
      try {
        if (field.type === 'radio') field.checked = field.value === value;
        else if (field.type === 'checkbox') field.checked = value === '1';
        else if (field.multiple) {
          const selected = new Set(JSON.parse(value));
          for (const option of field.options) option.selected = selected.has(option.value);
        } else field.value = value;
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new Event('change', { bubbles: true }));
      } catch {}
    });
  };

  window.t3 = Object.freeze({
    state: (() => {
      try {
        return typeof data === 'string' ? JSON.parse(data) : undefined;
      } catch {
        return undefined;
      }
    })(),
    setState(value) {
      const serialized = JSON.stringify(value);
      if (serialized === undefined || serialized.length > ${STATE_MAX_DATA_LENGTH}) {
        console.warn('t3.setState: the state must be JSON under ${STATE_MAX_DATA_LENGTH} characters.');
        return;
      }
      data = serialized;
      reportState();
    },
  });

  document.addEventListener('click', (event) => {
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    const href = link?.getAttribute('href');
    if (!href || href.startsWith('#')) return;
    event.preventDefault();
    post({ id: 't3:' + nextId++, method: 'ui/open-link', params: { url: new URL(href, document.baseURI).href } });
  }, true);
  document.addEventListener('submit', (event) => event.preventDefault(), true);
  document.addEventListener('input', reportState, true);
  document.addEventListener('change', reportState, true);
  window.addEventListener('pagehide', () => post({ method: '${UNLOADING_METHOD}', params: {} }));

  const initializeId = 't3:' + nextId++;
  let initialized = false;
  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') return;
    if (message.id === initializeId && message.result && !initialized) {
      initialized = true;
      applyContext(message.result.hostContext);
      post({ method: 'ui/notifications/initialized', params: {} });
      reportSize();
    } else if (message.method === 'ui/notifications/host-context-changed') {
      applyContext(message.params);
      reportSize();
    }
  });

  const start = () => {
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(reportSize);
      observer.observe(document.documentElement);
      if (document.body) observer.observe(document.body);
    }
    post({
      id: initializeId,
      method: 'ui/initialize',
      params: {
        protocolVersion: '${MCP_APPS_PROTOCOL_VERSION}',
        appInfo: { name: 'T3 Code artifact', version: '1' },
        appCapabilities: {},
      },
    });
    reportSize();
    restoreFields();
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
true;
`;

// Hosts also stop a frame that navigates itself, since a policy cannot prevent that. Desktop frames
// inherit the app policy, so scripts get only what desktop allows, which excludes `unsafe-eval`.
const MESSAGE_ARTIFACT_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "script-src 'unsafe-inline' 'wasm-unsafe-eval'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
].join("; ");

/** Page defaults until the host context applies; the card behind the page shows through. */
const MESSAGE_ARTIFACT_PAGE_STYLES = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 16px;
  background: transparent;
  color: var(--color-text-primary, CanvasText);
  font-family: var(--font-sans, system-ui, sans-serif);
  font-size: var(--font-text-md-size, 14px);
  line-height: 1.5;
}
`;

/** Escapes `<` so a value cannot terminate the script element that carries it. */
function serializeForScript(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

/**
 * Wraps an artifact in one self-contained document with the host context and restored state.
 * Build it each time a frame mounts, so the page starts from the latest remembered state.
 */
export function createSandboxedMessageArtifactDocument(
  source: string,
  options?: {
    readonly context?: MessageArtifactHostContext | undefined;
    readonly state?: MessageArtifactState | undefined;
  },
): string {
  return [
    "<!doctype html>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="${MESSAGE_ARTIFACT_CONTENT_SECURITY_POLICY}">`,
    '<meta http-equiv="x-dns-prefetch-control" content="off">',
    '<meta name="referrer" content="no-referrer">',
    `<style data-t3-artifact-host>${MESSAGE_ARTIFACT_PAGE_STYLES}</style>`,
    `<script data-t3-artifact-host>window.__t3ArtifactHost=${serializeForScript({
      context: options?.context,
      state: options?.state,
    })}</script>`,
    `<script data-t3-artifact-bridge>${MESSAGE_ARTIFACT_BRIDGE_SCRIPT}</script>`,
    source,
  ].join("");
}

/**
 * Fetches the artifact's text with a deadline, so a stalled response cannot hang the card. Every
 * failure becomes one of the messages above, so raw network errors never reach the UI.
 */
export async function fetchMessageArtifactHtml(
  url: string,
  signal: AbortSignal,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<string> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) controller.abort();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetchImpl(url, {
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!response.ok || !contentType.startsWith("text/plain")) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error(MESSAGE_ARTIFACT_LOAD_FAILED_MESSAGE);
    }
    // React Native has no response streams; the server already caps artifacts at 1 MB.
    if (typeof response.body?.getReader !== "function") return await response.text();
    return (await readFilePreviewResponse(response, controller.signal)).text;
  } catch (cause) {
    throw new Error(
      timedOut ? MESSAGE_ARTIFACT_TIMEOUT_MESSAGE : MESSAGE_ARTIFACT_LOAD_FAILED_MESSAGE,
      { cause },
    );
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

/** Fetches a copy. A failure becomes the message to show, so hosts only render the result. */
export async function loadMessageArtifactSource(
  url: string,
  signal: AbortSignal,
): Promise<MessageArtifactSource> {
  try {
    return { _tag: "Ready", source: await fetchMessageArtifactHtml(url, signal) };
  } catch (cause) {
    return {
      _tag: "Failure",
      message: cause instanceof Error ? cause.message : MESSAGE_ARTIFACT_LOAD_FAILED_MESSAGE,
    };
  }
}
