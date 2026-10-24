// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - Playwright callbacks run outside the Effect runtime.

import {
  type BrowserRecordingFrameRate,
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
import type { CDPSession, ConsoleMessage, Frame, Locator, Page } from "playwright-core";
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

export type PointerReporter = (
  point: { readonly x: number; readonly y: number },
  phase: "move" | "click",
) => Promise<void>;
const noPointer: PointerReporter = async () => {};

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
    visibleText: document.body?.innerText || "",
    interactiveElements: [],
  };
})()`;

const MASKED_VALUE = "••••••••";

/**
 * A `data:` URL carries its content, which can be a whole file, and URLs and diagnostics
 * reach tool results and provider logs. Keeps only the media type: the payload can hold any
 * character and parameters are page-chosen too.
 */
export const withoutDataPayload = (url: string) => {
  // Read the scheme as a browser would: it ignores leading controls and spaces, and tabs and
  // newlines anywhere. A snapshot's YAML value may be quoted and escaped; an escape that isn't a
  // tab or newline still decodes to something that can't start a scheme.
  const value = url
    .replace(/^["']/, "")
    .replace(/\\(x[\da-f]{2}|u[\da-f]{4}|.)/gi, (_escape, code: string) =>
      code.length > 1
        ? String.fromCharCode(Number.parseInt(code.slice(1), 16))
        : ({ t: "\t", n: "\n", r: "\r", '"': '"', "\\": "\\" }[code] ?? "\u0001"),
    )
    .replace(/[\t\n\r]/g, "")
    // eslint-disable-next-line no-control-regex -- URL parsing ignores these controls.
    .replace(/^[\u0000-\u0020]+/, "");
  const parsed = /^data:([^,;]*)/i.exec(value);
  if (!parsed) return url;
  const type = parsed[1]!.trim();
  const mediaType = /^[\w.+-]{1,64}\/[\w.+-]{1,64}$/.test(type) ? type : "";
  return `data:${mediaType},…`;
};

/**
 * Chromium's own console messages, which carry no arguments, quote `data:` URLs whole, as in a
 * blocked navigation or a CSP violation. Everything after the first one goes, since Chromium
 * accepts any type and a payload can hold any character. What a page logs itself is its own
 * text, like anything else it shows, so it stays.
 */
export const consoleText = (message: ConsoleMessage) =>
  message.args().length > 0
    ? message.text()
    : message.text().replace(/(?<![a-z\d])data:[^,;]*[,;][\s\S]*/i, withoutDataPayload);

// Split on LF alone: a value keeps any U+2028 that a multiline regex would treat as a line end.
const withoutTreeDataPayloads = (tree: string) =>
  tree
    .split("\n")
    .map((line) => {
      const url = /^(\s*- \/url: )(.*)$/s.exec(line);
      return url ? url[1] + withoutDataPayload(url[2]!) : line;
    })
    .join("\n");

// The broker waits 15s for the host; a snapshot, retry included, answers well before.
const SNAPSHOT_TIMEOUT_MS = 10_000;
// How long a frame in another process gets to answer; one that crashed never does.
const FRAME_ANSWER_MS = 1_000;

// Values the page draws as dots (password fields, and text fields whose CSS
// draws dots), normalized like accessible text. Open shadow roots included.
const DOTTED_SCRIPT = `(() => {
  const values = [];
  const visit = (root) => {
    for (const element of root.querySelectorAll("*")) {
      if (element.shadowRoot) visit(element.shadowRoot);
      const field = element.localName === "input" || element.localName === "textarea";
      if (!field && !element.isContentEditable) continue;
      const dots = getComputedStyle(element).getPropertyValue("-webkit-text-security");
      if (element.type !== "password" && (dots === "none" || dots === "")) continue;
      // Raw as page text shows it, and normalized as the tree does.
      for (const value of field ? [element.value, element.defaultValue] : [element.textContent ?? ""])
        values.push(value, value.replace(/[\\u200b\\u00ad]/g, "").trim().replace(/\\s+/g, " "));
    }
  };
  visit(document);
  return [...new Set(values.filter((value) => value.trim()))];
})()`;

const pageChanged = () =>
  new ServerBrowserOperationError(
    "PreviewAutomationExecutionError",
    "The page changed while capturing its snapshot. Take another snapshot.",
  );

const tooBusy = () =>
  new ServerBrowserOperationError(
    "PreviewAutomationTimeoutError",
    "The page was too busy to capture a snapshot in time. Wait for it to settle and take another snapshot.",
  );

const VALUE_TOO_LONG = "A password field holds a value too long to hide, so no snapshot was taken.";

/** A frame in another process keeps one CDP session, so none pile up across snapshots. */
const frameSessions = new WeakMap<Frame, Promise<CDPSession>>();

/** The value, or undefined when it fails or takes longer than a frame may. */
const answered = <A>(promise: Promise<A>) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), FRAME_ANSWER_MS);
  });
  return Promise.race([promise.catch(() => undefined), late]).finally(() => clearTimeout(timer));
};

/**
 * Reads dotted values in isolated worlds, where page script can't change what `value`
 * returns, through the CDP session of the process each frame renders in. A frame in
 * another process that can't be attached, as in desktop tabs where only the page can,
 * is read in the page's own world, where its script can change `value`. `read` gives
 * each reader's values, or undefined for one that didn't answer, and fails when the
 * page's own frames don't or frames came or went.
 */
const openReaders = async (page: Page, cdp: CDPSession) => {
  const frames = page.frames();
  const owners = new Map<Frame, CDPSession | null | undefined>(
    await Promise.all(
      frames.map(async (frame) => {
        if (frame === page.mainFrame()) return [frame, cdp] as const;
        const session = frameSessions.get(frame) ?? page.context().newCDPSession(frame);
        frameSessions.set(frame, session);
        try {
          return [frame, await session] as const;
        } catch (cause) {
          frameSessions.delete(frame);
          // CdpRelay refuses all but the page. Any other refusal reads the frame through its
          // parent's session, which fails the read if the frame isn't there.
          const desktop = String(cause).includes("Only this preview tab's page can be attached");
          return [frame, desktop ? null : undefined] as const;
        }
      }),
    ),
  );
  const ownerOf = (frame: Frame): CDPSession | null => {
    const owner = owners.get(frame);
    if (owner !== undefined) return owner;
    const parent = frame.parentFrame();
    return parent ? ownerOf(parent) : null;
  };
  const sessionReader = (frame: Frame, session: CDPSession) => {
    const owned = frames.filter((each) => ownerOf(each) === session);
    const open = async () => {
      const { frameTree } = await session.send("Page.getFrameTree");
      const ids = (node: typeof frameTree): Array<string> => [
        node.frame.id,
        ...(node.childFrames ?? []).flatMap(ids),
      ];
      // A frame Playwright knows but this session doesn't would go unread.
      if (ids(frameTree).length !== owned.length) throw pageChanged();
      return Promise.all(
        ids(frameTree).map(async (frameId) => {
          const world = await session.send("Page.createIsolatedWorld", {
            frameId,
            worldName: "t3-preview",
          });
          return world.executionContextId;
        }),
      );
    };
    let contexts: ReturnType<typeof open> | undefined;
    const read = async () => {
      const values = (contexts ??= open()).then((ids) =>
        Promise.all(
          ids.map(async (contextId) => {
            const { result, exceptionDetails } = await session.send("Runtime.evaluate", {
              contextId,
              expression: DOTTED_SCRIPT,
              returnByValue: true,
            });
            if (exceptionDetails) throw pageChanged();
            return result.value as Array<string>;
          }),
        ),
      );
      try {
        return (await values).flat();
      } catch (cause) {
        // The frame may have moved to another process; the next snapshot opens a new session.
        if (session !== cdp) {
          frameSessions.delete(frame);
          void session.detach().catch(constVoid);
        }
        throw cause;
      }
    };
    return { frames: owned, read };
  };
  const readers = [
    sessionReader(page.mainFrame(), cdp),
    ...frames.flatMap((frame) => {
      const owner = owners.get(frame);
      if (owner) return owner === cdp ? [] : [sessionReader(frame, owner)];
      const own = () => frame.evaluate(DOTTED_SCRIPT) as Promise<Array<string>>;
      return ownerOf(frame) === null ? [{ frames: [frame], read: own }] : [];
    }),
  ];
  return {
    readers,
    /** Readers that didn't answer `before` aren't asked again. */
    read: async (before?: ReadonlyArray<unknown>) => {
      const now = page.frames();
      // A frame added since the readers opened has none.
      if (now.length !== frames.length || now.some((frame, i) => frame !== frames[i])) {
        throw pageChanged();
      }
      return Promise.all(
        readers.map((reader, i) => {
          if (i === 0) return reader.read().catch(() => Promise.reject(pageChanged()));
          return before && !before[i] ? undefined : answered(reader.read());
        }),
      );
    },
  };
};

/**
 * Matches each value as the snapshot prints it: raw, as a JSON name, as a
 * quoted value, and with '' for each quote inside a quoted key. A value under
 * four characters only matches between non-word characters; inside other words
 * it would mask unrelated text.
 */
const dottedPattern = (values: ReadonlyArray<string>) => {
  const sources = values
    .flatMap((value) => {
      const json = JSON.stringify(value).slice(1, -1);
      // Playwright writes control characters like JSON does, with \xNN for the unnamed ones.
      const quoted = value.replace(/[\\"\p{Cc}]/gu, (char) =>
        '\\"\b\f\n\r\t'.includes(char)
          ? JSON.stringify(char).slice(1, -1)
          : `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`,
      );
      const forms = [value, json, quoted].flatMap((form) => [form, form.replaceAll("'", "''")]);
      return [...new Set(forms)].map((form) => ({ form, word: value.length < 4 }));
    })
    // Longest first, so a form inside another never leaves the rest showing.
    .toSorted((a, b) => b.form.length - a.form.length)
    .map(({ form, word }) => {
      const literal = form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return word ? `(?<![\\p{L}\\p{N}_])${literal}(?![\\p{L}\\p{N}_])` : literal;
    });
  if (sources.length === 0) return undefined;
  const pattern = new RegExp(sources.join("|"), "gu");
  try {
    // Compiles it now, for one-byte and two-byte text: one too large fails only when it
    // first runs on each, naming every value.
    pattern.test("");
    pattern.test("\u2022");
  } catch {
    throw new ServerBrowserOperationError("PreviewAutomationExecutionError", VALUE_TOO_LONG);
  }
  return pattern;
};

// `- role "name" [attribute]...: value`, the key single-quoted when it holds ": ". A name
// that starts and ends with "/" prints unquoted. Only Playwright's own attributes count, so
// text around a value in a name can't pass for one.
const TREE_LINE =
  /^(\s*- '?[^\s"':]+)( "(?:[^"\\]|\\.)*"| \/(?:.*?\/)?)?((?: \[(?:active|checked(?:=mixed)?|disabled|expanded|level=\d+|pressed(?:=mixed)?|selected|ref=(?:f\d+)?e\d+|cursor=pointer|box=-?\d+,-?\d+,\d+,\d+)\])*'?)(:.*)?$/;

/**
 * Masks each value on a line, except one that only matches inside the role or attributes,
 * so refs keep working. A "/.../" name has no closing mark, so a value can seem to cross it.
 */
const maskTree = (tree: string, dotted: RegExp) =>
  tree
    .split("\n")
    .map((line) => {
      const node = TREE_LINE.exec(line);
      const name = node?.[1]?.length ?? 0;
      const attributes = name + (node?.[2]?.length ?? 0);
      const end = attributes + (node?.[3]?.length ?? 0);
      const kept = (from: number, to: number) => to <= name || (from >= attributes && to <= end);
      return line.replace(dotted, (match: string, offset: number) =>
        kept(offset, offset + match.length) ? match : MASKED_VALUE,
      );
    })
    .join("\n");

/** Chromium sizes the capture, so the reported size is read from the PNG header. */
const pngSize = (base64: string) => {
  const header = Buffer.from(base64.slice(0, 32), "base64");
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
};

type Viewport = { readonly width: number; readonly height: number };

/**
 * A page's display ratio and CSS viewport, read in an isolated world since page script can
 * reassign `devicePixelRatio`, `innerWidth`, and `innerHeight` in its own, and its page zoom.
 */
const readPageMetrics = async (cdp: CDPSession) => {
  const { frameTree } = await cdp.send("Page.getFrameTree");
  const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
    frameId: frameTree.frame.id,
    worldName: "t3-preview-metrics",
  });
  let { cssVisualViewport } = await cdp.send("Page.getLayoutMetrics");
  // Desktop zoom applies asynchronously; bracket the CSS metrics to reject a torn read.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const zoom = cssVisualViewport.zoom ?? 1;
    const { result } = await cdp.send("Runtime.evaluate", {
      expression: "({ ratio: devicePixelRatio, width: innerWidth, height: innerHeight })",
      contextId: executionContextId,
      returnByValue: true,
    });
    ({ cssVisualViewport } = await cdp.send("Page.getLayoutMetrics"));
    if ((cssVisualViewport.zoom ?? 1) === zoom) {
      const { ratio, width, height } = result.value as {
        readonly ratio: number;
        readonly width: number;
        readonly height: number;
      };
      return {
        ratio,
        width,
        height,
        zoom,
        offset: { x: cssVisualViewport.pageX * zoom, y: cssVisualViewport.pageY * zoom },
      };
    }
  }
  throw new Error(
    "The page's zoom kept changing while the snapshot read its size. Try the snapshot again.",
  );
};

// Scaled captures repaint live screencasts, so callers pause them. Clips use document offsets.
export const captureViewport = async (
  page: Page,
  cdp: CDPSession,
  options: {
    readonly format: "png" | "jpeg";
    readonly quality?: number;
    readonly scale: number;
    readonly viewport?: Viewport;
    readonly offset?: { readonly x: number; readonly y: number } | undefined;
  },
) => {
  let clip;
  if (options.scale < 1) {
    const viewport = options.viewport ?? page.viewportSize() ?? { width: 1280, height: 800 };
    let offset = options.offset;
    if (!offset) {
      const { cssVisualViewport } = await cdp.send("Page.getLayoutMetrics");
      const zoom = cssVisualViewport.zoom ?? 1;
      offset = { x: cssVisualViewport.pageX * zoom, y: cssVisualViewport.pageY * zoom };
    }
    clip = {
      ...offset,
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

type SnapshotInput = {
  readonly page: Page;
  readonly cdp: CDPSession;
  /** Headless pages render at the scale the server set; a desktop page at its display's. */
  readonly renderScale: number | "display";
  readonly consoleEntries: ReadonlyArray<PreviewAutomationConsoleEntry>;
  readonly networkEntries: ReadonlyArray<PreviewAutomationNetworkEntry>;
  readonly actionTimeline: PreviewAutomationSnapshot["actionTimeline"];
};

/** The scale a page renders at and its viewport in device-independent pixels, a clip's units. */
const renderingOf = async (input: SnapshotInput) => {
  if (input.renderScale !== "display") {
    const viewport = input.page.viewportSize() ?? { width: 1280, height: 800 };
    return { renderScale: input.renderScale, viewport, offset: undefined };
  }
  // The display ratio a desktop page reports includes its page zoom, and its sizes are CSS pixels.
  const page = await readPageMetrics(input.cdp);
  return {
    renderScale: page.ratio / page.zoom,
    offset: page.offset,
    viewport: {
      width: Math.round(page.width * page.zoom),
      height: Math.round(page.height * page.zoom),
    },
  };
};

const capture = async (
  input: SnapshotInput,
  deadline: number,
): Promise<PreviewAutomationSnapshot> => {
  const { renderScale, viewport, offset } = await renderingOf(input);
  // A late metrics reply must not begin a capture after viewers have resumed.
  if (Date.now() >= deadline) throw tooBusy();
  const scale = Math.min(1, MAX_SCREENSHOT_WIDTH / (viewport.width * renderScale));
  const state = refsFor(input.page);
  invalidateRefs(input.page);
  const generation = state.generation;
  const { readers, read } = await openReaders(input.page, input.cdp);
  const before = await read();
  // Taken between the reads, so a value that changes during either fails the comparison.
  // Awaited after the tree: a capture that fails has finished its tree before a retry starts.
  const pageAndScreenshot = Promise.all([
    input.page.evaluate(SNAPSHOT_SCRIPT) as Promise<
      Pick<
        PreviewAutomationSnapshot,
        "url" | "title" | "loading" | "visibleText" | "interactiveElements"
      >
    >,
    captureViewport(input.page, input.cdp, { format: "png", scale, viewport, offset }),
  ]);
  void pageAndScreenshot.catch(constVoid);
  // Leaves time for the second read; a frame that never loads holds the tree until then.
  const tree = await input.page.ariaSnapshot({
    mode: "ai",
    boxes: true,
    timeout: Math.max(1, deadline - Date.now() - 2_000),
  });
  const after = await read(before);
  // A value that changed meanwhile may be in the tree under neither reading.
  if (after.some((values, i) => values && JSON.stringify(values) !== JSON.stringify(before[i])))
    throw pageChanged();
  const dotted = dottedPattern(after.flatMap((values) => values ?? []));
  // A frame that didn't answer both times, such as one that crashed, can only hold values the
  // tree shows if the tree shows its content.
  const unread = readers.flatMap((reader, i) => (after[i] ? [] : reader.frames));
  const filled = /^\s*- iframe (?:\[active\] )?\[ref=(\S+?)\].*:$/gm;
  for (const [, ref] of unread.length ? tree.matchAll(filled) : []) {
    const iframe = await input.page.locator(`aria-ref=${ref}`).elementHandle({ timeout: 2_000 });
    if (!iframe) throw pageChanged();
    const frame = await iframe.contentFrame();
    void iframe.dispose().catch(constVoid);
    if (frame && unread.includes(frame)) throw tooBusy();
  }
  const [page, data] = await pageAndScreenshot;
  if (state.generation !== generation) throw pageChanged();
  const mask = (text: string) => (dotted ? text.replace(dotted, MASKED_VALUE) : text);
  // Redacted before the cut, so a payload crossing it can't leave its start showing, and before
  // masking, which could hide the `data:` scheme behind a password value's dots.
  const redacted = withoutTreeDataPayloads(tree);
  const accessibilityTree = (dotted ? maskTree(redacted, dotted) : redacted)
    .slice(0, MAX_VISIBLE_TEXT_LENGTH)
    .replace(/\[ref=((?:f\d+)?e\d+)\]/g, (_match, nativeRef: string) => {
      const ref = `t3-${generation}-${nativeRef}`;
      state.refs.set(ref, nativeRef);
      return `[ref=${ref}]`;
    });
  return {
    ...page,
    // Text that holds a value would otherwise show where the tree masked it. Masked before
    // the cut, so a value crossing it can't leave its start showing.
    visibleText: mask(page.visibleText).slice(0, MAX_VISIBLE_TEXT_LENGTH),
    accessibilityTree,
    consoleEntries: [...input.consoleEntries],
    networkEntries: [...input.networkEntries],
    actionTimeline: [...input.actionTimeline],
    screenshot: {
      mimeType: "image/png",
      data,
      ...pngSize(data),
    },
  };
};

/** Snapshots begun per page; observers' snapshots aren't queued, so two can overlap. */
const snapshotTurns = new WeakMap<Page, number>();

export const snapshot = async (input: SnapshotInput): Promise<PreviewAutomationSnapshot> => {
  const deadline = Date.now() + SNAPSHOT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(tooBusy()), SNAPSHOT_TIMEOUT_MS);
  });
  const turn = (snapshotTurns.get(input.page) ?? 0) + 1;
  snapshotTurns.set(input.page, turn);
  // A page that changed mid-capture, like one rotating ads, has usually settled by a second
  // try. None starts late or after another snapshot began, since it would revoke the refs of
  // whichever snapshot came next.
  const captured = capture(input, deadline).catch((cause: unknown) =>
    Date.now() < deadline &&
    snapshotTurns.get(input.page) === turn &&
    !(cause instanceof Error && cause.message === VALUE_TOO_LONG)
      ? capture(input, deadline)
      : Promise.reject(cause),
  );
  try {
    return await Promise.race([captured, expired]);
  } catch (cause) {
    throw cause instanceof Error && cause.name === "TimeoutError" ? tooBusy() : cause;
  } finally {
    clearTimeout(timer);
  }
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
  // Observe the drag's outcome as it starts: a rejection nobody handles while the cursor
  // moves exits the server.
  const dragFailure = source.dragTo(target, { timeout }).then(
    () => null,
    (error: unknown) => ({ error }),
  );
  const end = await target.boundingBox({ timeout }).catch(() => null);
  if (end) await pointer({ x: end.x + end.width / 2, y: end.y + end.height / 2 }, "move");
  const failure = await dragFailure;
  if (failure) throw failure.error;
};

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

export const recordingEncoderScript = (frameRate: BrowserRecordingFrameRate) => `(() => {
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
        const bitsPerSecond = Math.min(50e6, Math.max(2.5e6, bitmap.width * bitmap.height * ${frameRate} * 0.05));
        recorder = new MediaRecorder(canvas.captureStream(${frameRate}), { mimeType, videoBitsPerSecond: bitsPerSecond });
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
