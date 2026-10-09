// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - Playwright callbacks run outside the Effect runtime.

import {
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  type PreviewAutomationClickInput,
  type PreviewAutomationConsoleEntry,
  type PreviewAutomationDragInput,
  type PreviewAutomationEvaluateInput,
  type PreviewAutomationHoverInput,
  type PreviewAutomationNetworkEntry,
  type PreviewAutomationPressInput,
  type PreviewAutomationScrollInput,
  type PreviewAutomationSelectInput,
  type PreviewAutomationSelectResult,
  type PreviewAutomationSnapshot,
  type PreviewAutomationTypeInput,
  type PreviewAutomationUploadInput,
  type PreviewAutomationWaitForInput,
} from "@t3tools/contracts";
import { constVoid } from "effect/Function";
import type { CDPSession, Locator, Page } from "playwright-core";
import * as NodeCrypto from "node:crypto";
import { BrowserControlInterrupted } from "./SessionControl.ts";

const MAX_EVALUATION_BYTES = 64_000;
const MAX_VISIBLE_TEXT_LENGTH = 20_000;
const MAX_SCREENSHOT_WIDTH = 1280;
const WAIT_POLL_MS = 100;
export const DIAGNOSTIC_BUFFER_LIMIT = 200;

export class ServerBrowserOperationError extends Error {
  readonly tag: string;
  readonly detail: unknown;

  constructor(tag: string, message: string, detail?: unknown) {
    super(message);
    this.tag = tag;
    this.detail = detail;
  }
}

export const toOperationError = (cause: unknown): ServerBrowserOperationError => {
  if (cause instanceof BrowserControlInterrupted)
    return new ServerBrowserOperationError(
      "PreviewAutomationControlInterruptedError",
      cause.message,
      cause.reason,
    );
  if (cause instanceof ServerBrowserOperationError) return cause;
  const message = cause instanceof Error ? cause.message : String(cause);
  const firstLine = message.split("\n")[0] ?? message;
  if (cause instanceof Error && cause.name === "TimeoutError") {
    return new ServerBrowserOperationError("PreviewAutomationTimeoutError", firstLine);
  }
  if (
    /while parsing selector|Unknown engine|Unexpected token|strict mode violation/i.test(message)
  ) {
    return new ServerBrowserOperationError("PreviewAutomationInvalidSelectorError", firstLine);
  }
  if (/not an <input>|not editable|not an editable/i.test(message)) {
    return new ServerBrowserOperationError("PreviewAutomationTargetNotEditableError", firstLine);
  }
  return new ServerBrowserOperationError("PreviewAutomationExecutionError", firstLine);
};

const DEFAULT_TIMEOUT_MS = 15_000;

const pageRefs = new WeakMap<Page, { generation: string; refs: Map<string, string> }>();
// A compact runtime namespace prevents old refs from aliasing after a server restart.
const refNamespace = NodeCrypto.randomUUID().slice(0, 8);
let snapshotSequence = 0;
const nextRefGeneration = () => `${refNamespace}-${(++snapshotSequence).toString(36)}`;

/** A takeover revokes previously issued refs even when the document stays unchanged. */
export const invalidateRefs = (page: Page) => {
  const state = pageRefs.get(page);
  if (state) {
    state.generation = nextRefGeneration();
    state.refs.clear();
  }
};

const refsFor = (page: Page) => {
  let state = pageRefs.get(page);
  if (!state) {
    state = { generation: nextRefGeneration(), refs: new Map<string, string>() };
    pageRefs.set(page, state);
    page.on("framenavigated", () => invalidateRefs(page));
    page.on("framedetached", () => invalidateRefs(page));
  }
  return state;
};

const targetLocator = (
  page: Page,
  input: { readonly locator?: string | undefined; readonly selector?: string | undefined },
): Locator | null => {
  const selector = input.locator ?? input.selector;
  if (selector === undefined) return null;
  // Ignore quoted/escaped CSS values when looking for a selector-engine boundary.
  const engines = selector.replace(
    /\\.|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g,
    " ",
  );
  if (/(?:^|>>)\s*\*?aria-ref\s*=/.test(engines)) {
    const ref = /^\s*aria-ref\s*=\s*(\S+)\s*$/.exec(selector)?.[1];
    const nativeRef = ref === undefined ? undefined : pageRefs.get(page)?.refs.get(ref);
    if (nativeRef === undefined) {
      throw new ServerBrowserOperationError(
        "PreviewAutomationInvalidSelectorError",
        "This element ref is stale or belongs to another tab. Take a fresh snapshot and use its locator.",
        { staleRef: true },
      );
    }
    return page.locator(`aria-ref=${nativeRef}`);
  }
  // Playwright's strict locators reject ambiguous controls rather than acting on row one.
  return page.locator(selector);
};

/** Shows the agent's pointer to viewers before an action lands at that point. */
export type PointerReporter = (
  point: { readonly x: number; readonly y: number },
  phase: "move" | "click",
) => Promise<void>;
const noPointer: PointerReporter = async () => {};

/** The viewport point an action will hit: the target's center after scrolling it into view. */
const targetPoint = async (
  page: Page,
  locator: Locator | null,
  input: { readonly x?: number | undefined; readonly y?: number | undefined },
  timeout: number,
) => {
  if (locator === null) return { x: input.x ?? 0, y: input.y ?? 0 };
  await locator.scrollIntoViewIfNeeded({ timeout });
  const box = await locator.boundingBox({ timeout });
  if (box) return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const viewport = page.viewportSize();
  return { x: (viewport?.width ?? 0) / 2, y: (viewport?.height ?? 0) / 2 };
};

const SNAPSHOT_SCRIPT = `(() => {
  return {
    url: location.href,
    title: document.title,
    loading: document.readyState !== "complete",
    visibleText: (document.body?.innerText || "").slice(0, ${MAX_VISIBLE_TEXT_LENGTH}),
    interactiveElements: [],
  };
})()`;

// Scaled captures repaint live screencasts, so callers pause them. Clips use document offsets.
export const captureViewport = async (
  page: Page,
  cdp: CDPSession,
  options: { readonly format: "png" | "jpeg"; readonly quality?: number; readonly scale: number },
) => {
  let clip;
  if (options.scale < 1) {
    const viewport = page.viewportSize() ?? { width: 1280, height: 800 };
    const { cssVisualViewport } = await cdp.send("Page.getLayoutMetrics");
    clip = {
      x: cssVisualViewport.pageX,
      y: cssVisualViewport.pageY,
      ...viewport,
      scale: options.scale,
    };
  }
  const { data } = await cdp.send("Page.captureScreenshot", {
    format: options.format,
    ...(options.quality === undefined ? {} : { quality: options.quality }),
    ...(clip ? { clip } : {}),
  });
  return data;
};

export const snapshot = async (input: {
  readonly page: Page;
  readonly cdp: CDPSession;
  readonly renderScale: number;
  readonly consoleEntries: ReadonlyArray<PreviewAutomationConsoleEntry>;
  readonly networkEntries: ReadonlyArray<PreviewAutomationNetworkEntry>;
  readonly actionTimeline: PreviewAutomationSnapshot["actionTimeline"];
}): Promise<PreviewAutomationSnapshot> => {
  const viewport = input.page.viewportSize() ?? { width: 1280, height: 800 };
  const scale = Math.min(1, MAX_SCREENSHOT_WIDTH / (viewport.width * input.renderScale));
  const state = refsFor(input.page);
  invalidateRefs(input.page);
  const generation = state.generation;
  const [page, tree, data] = await Promise.all([
    input.page.evaluate(SNAPSHOT_SCRIPT) as Promise<
      Pick<
        PreviewAutomationSnapshot,
        "url" | "title" | "loading" | "visibleText" | "interactiveElements"
      >
    >,
    input.page.ariaSnapshot({ mode: "ai", boxes: true, timeout: DEFAULT_TIMEOUT_MS }),
    captureViewport(input.page, input.cdp, { format: "png", scale }),
  ]);
  if (state.generation !== generation) {
    throw new ServerBrowserOperationError(
      "PreviewAutomationExecutionError",
      "The page changed while capturing its snapshot. Take another snapshot.",
    );
  }
  const accessibilityTree = tree
    .slice(0, MAX_VISIBLE_TEXT_LENGTH)
    .replace(/\[ref=((?:f\d+)?e\d+)\]/g, (_match, nativeRef: string) => {
      const ref = `t3-${generation}-${nativeRef}`;
      state.refs.set(ref, nativeRef);
      return `[ref=${ref}]`;
    });
  return {
    ...page,
    accessibilityTree,
    consoleEntries: [...input.consoleEntries],
    networkEntries: [...input.networkEntries],
    actionTimeline: [...input.actionTimeline],
    screenshot: {
      mimeType: "image/png",
      data,
      width: Math.round(viewport.width * input.renderScale * scale),
      height: Math.round(viewport.height * input.renderScale * scale),
    },
  };
};

/**
 * A click whose handler opens a dialog does not finish until the dialog is
 * resolved, so it returns as soon as the dialog opens; status then reports it.
 */
export const click = async (
  page: Page,
  input: PreviewAutomationClickInput,
  pointer: PointerReporter = noPointer,
): Promise<{ readonly x: number; readonly y: number }> => {
  const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const locator = targetLocator(page, input);
  const point = await targetPoint(page, locator, input, timeout);
  await pointer(point, "click");
  const options = { button: input.button ?? "left", clickCount: input.clickCount ?? 1 } as const;
  const clicked =
    locator === null
      ? page.mouse.click(point.x, point.y, options)
      : locator.click({ ...options, timeout });
  let onDialog = constVoid;
  const dialogOpened = new Promise<"dialog">((resolve) => {
    onDialog = () => resolve("dialog");
    page.once("dialog", onDialog);
  });
  try {
    if ((await Promise.race([clicked, dialogOpened])) === "dialog") void clicked.catch(constVoid);
  } finally {
    page.off("dialog", onDialog);
  }
  return point;
};

export const type = async (page: Page, input: PreviewAutomationTypeInput) => {
  const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const locator = targetLocator(page, input);
  if (locator !== null && input.clear) {
    await locator.fill(input.text, { timeout });
    return;
  }
  // A shadow host also matches :focus; use its innermost focused descendant.
  const target = locator ?? page.locator("*:focus").last();
  const focused =
    (locator !== null || (await target.count()) > 0) &&
    (await target.evaluate(
      (element) => {
        // Like the desktop host: an enabled text control or contenteditable
        // that actually takes focus. Anything else would swallow the text or
        // send it to whichever field had focus before.
        const control = element as unknown as {
          readonly type?: string;
          readonly disabled?: boolean;
          readonly readOnly?: boolean;
          readonly isContentEditable?: boolean;
          readonly focus?: () => void;
        };
        const nonText = [
          "button",
          "checkbox",
          "color",
          "file",
          "hidden",
          "image",
          "radio",
          "range",
          "reset",
          "submit",
        ];
        const textControl =
          element.tagName === "TEXTAREA" ||
          (element.tagName === "INPUT" && !nonText.includes(control.type ?? "text"));
        if (!(textControl || control.isContentEditable) || control.disabled || control.readOnly) {
          return false;
        }
        control.focus?.();
        const root = element.getRootNode() as { readonly activeElement?: typeof element | null };
        const active = root.activeElement;
        return active != null && (active === element || element.contains(active));
      },
      undefined,
      { timeout },
    ));
  if (focused !== true) {
    throw new ServerBrowserOperationError(
      "PreviewAutomationTargetNotEditableError",
      "The target is not an enabled text field, so no text was typed.",
    );
  }
  if (input.clear) {
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("Delete");
  }
  await page.keyboard.insertText(input.text);
};

/** Hovering by locator moves the real mouse, so CSS :hover and pointer events both apply. */
export const hover = async (
  page: Page,
  input: PreviewAutomationHoverInput,
  pointer: PointerReporter = noPointer,
) => {
  const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const locator = targetLocator(page, input);
  await pointer(await targetPoint(page, locator, input, timeout), "move");
  if (locator === null) {
    await page.mouse.move(input.x ?? 0, input.y ?? 0);
    return;
  }
  await locator.hover({ timeout });
};

export const select = async (
  page: Page,
  input: PreviewAutomationSelectInput,
): Promise<PreviewAutomationSelectResult> => {
  const locator = targetLocator(page, input)!;
  const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Each entry matches an option by value first, then by its visible label.
  const options = await locator.evaluate(
    (element) =>
      element.tagName === "SELECT"
        ? Array.from(
            (element as unknown as { options: ArrayLike<{ value: string; label: string }> })
              .options,
            ({ value, label }) => ({ value, label: label.trim() }),
          )
        : null,
    undefined,
    { timeout },
  );
  const values =
    options &&
    input.values.map(
      (entry) =>
        (
          options.find((option) => option.value === entry) ??
          options.find((option) => option.label === entry.trim())
        )?.value ?? entry,
    );
  if (values === null)
    throw new ServerBrowserOperationError(
      "PreviewAutomationTargetNotEditableError",
      "This element is not a <select>. Click a custom dropdown, then click its option.",
    );
  return { selected: await locator.selectOption(values, { timeout }) };
};

export const drag = async (
  page: Page,
  input: PreviewAutomationDragInput,
  pointer: PointerReporter = noPointer,
) => {
  const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const source = targetLocator(page, { locator: input.source })!;
  const target = targetLocator(page, { locator: input.target })!;
  await pointer(await targetPoint(page, source, {}, timeout), "move");
  // The cursor travels with the drag; the page sees one continuous gesture. Observe the drag's
  // outcome as it starts: a rejection nobody handles while the cursor moves exits the server.
  const dragFailure = source.dragTo(target, { timeout }).then(
    () => null,
    (error: unknown) => ({ error }),
  );
  const end = await target.boundingBox({ timeout }).catch(() => null);
  if (end) await pointer({ x: end.x + end.width / 2, y: end.y + end.height / 2 }, "move");
  const failure = await dragFailure;
  if (failure) throw failure.error;
};

/** Sets files on one file input; false when no locator or selector names one. */
export const setInputFiles = async (page: Page, input: PreviewAutomationUploadInput) => {
  const locator = targetLocator(page, input);
  if (locator === null) return false;
  await locator.setInputFiles([...input.paths], { timeout: input.timeoutMs ?? DEFAULT_TIMEOUT_MS });
  return true;
};

export const press = async (page: Page, input: PreviewAutomationPressInput) => {
  await page.keyboard.press([...(input.modifiers ?? []), input.key].join("+"));
};

export const scroll = async (page: Page, input: PreviewAutomationScrollInput) => {
  const delta = [input.deltaX ?? 0, input.deltaY ?? 0] as const;
  const locator = targetLocator(page, input);
  if (locator === null) {
    // Page-side code is passed as source: the server compiles without DOM types.
    await page.evaluate(`scrollBy(${delta[0]}, ${delta[1]})`);
    return;
  }
  await locator.evaluate((element, [x, y]) => element.scrollBy(x, y), delta);
};

/**
 * Runs an agent's expression, bounded by its request's deadline. Past it, the
 * page's script is terminated and the call fails, so the tab's control queue
 * frees for the next request instead of waiting on the script.
 */
export const evaluate = async (
  cdp: CDPSession,
  input: PreviewAutomationEvaluateInput,
  timeoutMs: number,
) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Stops a busy script; an awaited promise is abandoned and settles unread.
      void cdp.send("Runtime.terminateExecution").catch(constVoid);
      reject(
        new ServerBrowserOperationError(
          "PreviewAutomationTimeoutError",
          `Evaluation did not finish within ${timeoutMs}ms and was stopped.`,
        ),
      );
    }, timeoutMs);
  });
  const evaluation = cdp.send("Runtime.evaluate", {
    expression: input.expression,
    awaitPromise: input.awaitPromise ?? true,
    returnByValue: input.returnByValue ?? true,
  });
  void evaluation.catch(constVoid);
  const result = await Promise.race([evaluation, expired]).finally(() => clearTimeout(timer));
  if (result.exceptionDetails) {
    throw new ServerBrowserOperationError(
      "PreviewAutomationExecutionError",
      result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
    );
  }
  const value =
    "value" in result.result ? result.result.value : (result.result.description ?? null);
  const actualBytes = Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
  if (actualBytes > MAX_EVALUATION_BYTES) {
    throw new ServerBrowserOperationError(
      "PreviewAutomationResultTooLargeError",
      `Evaluation result is ${actualBytes} bytes; the limit is ${MAX_EVALUATION_BYTES}.`,
      { maximumBytes: MAX_EVALUATION_BYTES },
    );
  }
  return value;
};

export const waitFor = async (page: Page, input: PreviewAutomationWaitForInput) => {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const locator = targetLocator(page, input);
  const { text, urlIncludes } = input;
  const checks: Array<() => Promise<boolean>> = [];
  // Like the desktop host: the selector must match an element, visible or not.
  if (locator !== null) checks.push(async () => (await locator.count()) > 0);
  if (text !== undefined) {
    // A navigation can destroy the context mid-check; that counts as not yet.
    checks.push(() =>
      page
        .evaluate(`(document.body?.innerText ?? "").includes(${JSON.stringify(text)})`)
        .then((found) => found === true)
        .catch(() => false),
    );
  }
  if (urlIncludes !== undefined) checks.push(async () => page.url().includes(urlIncludes));
  for (;;) {
    const results = await Promise.all(checks.map((check) => check()));
    if (results.every(Boolean)) return;
    if (Date.now() >= deadline) {
      throw new ServerBrowserOperationError(
        "PreviewAutomationTimeoutError",
        `Waited ${timeoutMs}ms without every condition holding.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
  }
};

const NET_ERROR_CODES: Readonly<Record<string, number>> = {
  ERR_FAILED: -2,
  ERR_TIMED_OUT: -7,
  ERR_CONNECTION_CLOSED: -100,
  ERR_CONNECTION_RESET: -101,
  ERR_CONNECTION_REFUSED: -102,
  ERR_NAME_NOT_RESOLVED: -105,
  ERR_INTERNET_DISCONNECTED: -106,
  ERR_ADDRESS_UNREACHABLE: -109,
  ERR_CERT_AUTHORITY_INVALID: -202,
  ERR_EMPTY_RESPONSE: -324,
};

export const parseNetError = (errorText: string) => {
  const description = /ERR_[A-Z_]+/.exec(errorText)?.[0] ?? errorText;
  return { description, code: NET_ERROR_CODES[description] ?? -2 };
};

// Browser-side encoding avoids ffmpeg. Resizes are letterboxed into the first frame;
// the agent cursor is drawn here so it never changes the page under test.
export const RECORDING_ENCODER_SCRIPT = `(() => {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  const chunks = [];
  let recorder = null;
  let started = null;
  let stopped = null;
  let sizeBytes = 0;
  let tooLarge = false;
  let frame = null;
  let cursor = null;
  let ring = null;
  const AGENT_CURSOR_PATH = new Path2D("M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z");
  let ringTimer = null;
  let scale = 1;
  let offsetX = 0;
  let offsetY = 0;
  const paint = () => {
    if (!frame) return;
    const fit = Math.min(canvas.width / frame.width, canvas.height / frame.height);
    const width = frame.width * fit;
    const height = frame.height * fit;
    offsetX = (canvas.width - width) / 2;
    offsetY = (canvas.height - height) / 2;
    if (width < canvas.width || height < canvas.height) {
      context.fillStyle = "#000";
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
    context.drawImage(frame, offsetX, offsetY, width, height);
    scale = (width / frame.width) * frame.cssScale;
    if (ring) {
      const age = (performance.now() - ring.at) / 400;
      if (age < 1) {
        context.beginPath();
        context.arc(offsetX + ring.x * scale, offsetY + ring.y * scale, (8 + 18 * age) * scale, 0, Math.PI * 2);
        context.strokeStyle = "rgba(59,130,246," + (0.9 * (1 - age)) + ")";
        context.lineWidth = 3 * scale;
        context.stroke();
      }
    }
    if (cursor) {
      // The agent cursor (lucide MousePointer2, as in the live panel), never the human arrow.
      const s = 20 / 24 * scale;
      context.save();
      context.translate(offsetX + cursor.x * scale - 2 * scale, offsetY + cursor.y * scale - 2 * scale);
      context.scale(s, s);
      context.lineWidth = 2;
      context.lineJoin = "round";
      context.lineCap = "round";
      context.fillStyle = "#fff";
      context.strokeStyle = "#2563eb";
      context.shadowColor = "rgba(0,0,0,0.25)";
      context.shadowBlur = 2;
      context.fill(AGENT_CURSOR_PATH);
      context.shadowColor = "transparent";
      context.stroke(AGENT_CURSOR_PATH);
      context.restore();
    }
  };
  window.__t3Recorder = {
    async frame(base64, cssWidth) {
      if (tooLarge) return false;
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
      if (tooLarge) { bitmap.close(); return false; }
      if (!recorder) {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const mimeType = ["video/mp4;codecs=avc1.640033", "video/webm;codecs=vp9", "video/webm"].find((type) => MediaRecorder.isTypeSupported(type));
        const bitsPerSecond = Math.min(50e6, Math.max(2.5e6, bitmap.width * bitmap.height * 30 * 0.05));
        recorder = new MediaRecorder(canvas.captureStream(30), { mimeType, videoBitsPerSecond: bitsPerSecond });
        started = new Promise((resolve, reject) => {
          recorder.onstart = resolve;
          recorder.onerror = (event) => reject(event.error);
        });
        stopped = new Promise((resolve) => { recorder.onstop = resolve; });
        recorder.ondataavailable = (event) => {
          if (tooLarge || event.data.size === 0) return;
          sizeBytes += event.data.size;
          if (sizeBytes > ${PROVIDER_SEND_TURN_MAX_FILE_BYTES}) {
            tooLarge = true;
            chunks.length = 0;
            clearInterval(ringTimer);
            frame?.close();
            frame = null;
            if (recorder.state !== "inactive") recorder.stop();
            for (const track of recorder.stream.getTracks()) track.stop();
            return;
          }
          chunks.push(event.data);
        };
        recorder.start(1000);
      }
      // Frame px per page CSS px, before fitting into the canvas.
      bitmap.cssScale = bitmap.width / cssWidth;
      frame?.close();
      frame = bitmap;
      paint();
      await started;
      return true;
    },
    cursor(x, y, click) {
      if (tooLarge) return;
      cursor = { x, y };
      if (click) {
        ring = { x, y, at: performance.now() };
        clearInterval(ringTimer);
        ringTimer = setInterval(() => {
          paint();
          if (performance.now() - ring.at > 400) { ring = null; clearInterval(ringTimer); paint(); }
        }, 33);
      }
      paint();
    },
    async stop() {
      if (!recorder) return { mimeType: null, count: 0, bytes: 0 };
      if (recorder.state !== "inactive") {
        // Consume the cached frame, then wait for the final paint to reach the
        // capture stream. Animation ticks alone can stop before it is delivered.
        const video = document.createElement("video");
        video.muted = true;
        video.srcObject = recorder.stream;
        const nextFrame = () => Promise.race([
          new Promise(resolve => video.requestVideoFrameCallback(resolve)),
          stopped,
        ]);
        const initial = nextFrame();
        void video.play().catch(() => {});
        await initial;
        if (recorder.state !== "inactive") {
          const delivered = nextFrame();
          recorder.stream.getVideoTracks()[0].requestFrame();
          paint();
          await delivered;
        }
        video.pause();
        video.srcObject = null;
        if (recorder.state !== "inactive") recorder.stop();
      }
      await stopped;
      return { mimeType: recorder.mimeType, count: chunks.length, bytes: sizeBytes };
    },
    async chunk(index) {
      const bytes = new Uint8Array(await chunks[index].arrayBuffer());
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      }
      return btoa(binary);
    },
  };
})()`;
