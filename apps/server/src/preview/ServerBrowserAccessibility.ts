// @effect-diagnostics globalDate:off globalTimers:off - Playwright callbacks run outside the Effect runtime.
import {
  PREVIEW_ACCESSIBILITY_MAX_NODES,
  PREVIEW_ACCESSIBILITY_VALUE_MAX_CHARS,
  type PreviewAccessibilityAction,
  type PreviewAccessibilityDocument,
  type PreviewAccessibilityNode,
} from "@t3tools/contracts";
import { constVoid } from "effect/Function";
import type { CDPSession, Frame, Page } from "playwright-core";

/** The subset of CDP's `Accessibility.AXNode` this mirror reads. */
export interface RawAccessibilityNode {
  readonly nodeId: string;
  readonly ignored: boolean;
  readonly role?: { readonly value?: unknown };
  readonly name?: { readonly value?: unknown };
  readonly description?: { readonly value?: unknown };
  readonly value?: { readonly value?: unknown };
  readonly properties?: ReadonlyArray<{
    readonly name: string;
    readonly value: { readonly value?: unknown };
  }>;
  readonly parentId?: string;
  readonly childIds?: ReadonlyArray<string>;
  readonly backendDOMNodeId?: number;
}

export interface AccessibilityFrameTree {
  /** Capture session that owns the frame; node ids are unique within it. */
  readonly key: string;
  readonly nodes: ReadonlyArray<RawAccessibilityNode>;
  /** The iframe element that hosts this document, in its parent's session. */
  readonly owner?: { readonly key: string; readonly backendNodeId: number };
  /** Backend ids of fields whose values must never leave the server. */
  readonly secretNodes: ReadonlySet<number>;
}

export interface AccessibilityTarget {
  readonly key: string;
  readonly backendNodeId: number;
  readonly role: string;
  readonly disabled: boolean;
  readonly readonly: boolean;
  readonly editable: boolean;
}

const ROLE_ALIASES: Record<string, string> = {
  RootWebArea: "document",
  WebArea: "document",
  StaticText: "text",
  MenuListOption: "option",
};
/** Wrappers whose children read as part of the parent. */
const HOISTED_ROLES = new Set([
  "generic",
  "none",
  "presentation",
  "Iframe",
  "IframePresentational",
  "LabelText",
  "MenuListPopup",
  "Ruby",
  "Abbr",
  "Canvas",
]);
/** Duplicates of text their parent already carries. */
const SKIPPED_ROLES = new Set(["InlineTextBox", "ListMarker", "LineBreak"]);
const ACTIVATABLE_ROLES: ReadonlySet<string> = new Set([
  "link",
  "button",
  "checkbox",
  "radio",
  "switch",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "treeitem",
  "DisclosureTriangle",
  "PopUpButton",
  "ToggleButton",
]);
const EDITABLE_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);
const SECRET_AUTOCOMPLETE = new Set([
  "current-password",
  "new-password",
  "one-time-code",
  "cc-number",
  "cc-csc",
]);
const MASKED_VALUE = /^[•●∙*]+$/u;
const TEXT_MAX_CHARS = 2_000;
const MAX_DEPTH = 256;
const MAX_SECRET_CHECKS = 200;

const text = (value: unknown, max = TEXT_MAX_CHARS) => {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed.slice(0, max);
};
/** What the user typed, kept exactly; only the length is bounded. */
const fieldValue = (value: unknown) => {
  if (typeof value === "number") return String(value);
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.slice(0, PREVIEW_ACCESSIBILITY_VALUE_MAX_CHARS);
};
const truthy = (value: unknown) => value === true || value === "true";
const tristate = (value: unknown) =>
  value === "mixed" ? "mixed" : value === undefined ? undefined : truthy(value) ? "true" : "false";
const roleOf = (node: RawAccessibilityNode) => {
  const role = typeof node.role?.value === "string" ? node.role.value : "generic";
  return ROLE_ALIASES[role] ?? role;
};

/** Editable fields whose attributes must be read before their values may be sent. */
const valueFieldIds = (nodes: ReadonlyArray<RawAccessibilityNode>) =>
  nodes.flatMap((node) =>
    !node.ignored && node.backendDOMNodeId !== undefined && EDITABLE_ROLES.has(roleOf(node))
      ? [node.backendDOMNodeId]
      : [],
  );

export const isSecretField = (description: {
  readonly nodeName?: string;
  readonly attributes?: ReadonlyArray<string>;
}) => {
  const attributes = description.attributes ?? [];
  const attribute = (name: string) => {
    for (let index = 0; index < attributes.length - 1; index += 2) {
      if (attributes[index]?.toLowerCase() === name) return attributes[index + 1]!.toLowerCase();
    }
    return undefined;
  };
  if (description.nodeName?.toUpperCase() === "INPUT" && attribute("type") === "password") {
    return true;
  }
  return (attribute("autocomplete") ?? "")
    .split(/\s+/)
    .some((token) => SECRET_AUTOCOMPLETE.has(token));
};

/**
 * Joins per-frame CDP trees into one reading-order tree. Ignored and generic
 * wrappers are replaced by their children so their descendants stay readable.
 */
export function buildAccessibilityTree(
  frames: ReadonlyArray<AccessibilityFrameTree>,
  maxNodes = PREVIEW_ACCESSIBILITY_MAX_NODES,
): {
  readonly root: PreviewAccessibilityNode | null;
  readonly targets: ReadonlyMap<string, AccessibilityTarget>;
  readonly truncated: boolean;
} {
  const targets = new Map<string, AccessibilityTarget>();
  const visited = new Set<string>();
  const hosted = new Map<string, Array<AccessibilityFrameTree>>();
  for (const frame of frames.slice(1)) {
    if (!frame.owner) continue;
    const key = `${frame.owner.key}:${frame.owner.backendNodeId}`;
    hosted.set(key, [...(hosted.get(key) ?? []), frame]);
  }
  let count = 0;
  let truncated = false;

  const visitFrame = (frame: AccessibilityFrameTree, depth: number) => {
    const byId = new Map(frame.nodes.map((node) => [node.nodeId, node]));
    const root = frame.nodes.find((node) => node.parentId === undefined) ?? frame.nodes[0];
    return root ? visit(frame, byId, root, depth) : [];
  };

  const visit = (
    frame: AccessibilityFrameTree,
    byId: ReadonlyMap<string, RawAccessibilityNode>,
    raw: RawAccessibilityNode,
    depth: number,
  ): Array<PreviewAccessibilityNode> => {
    const id = `${frame.key}.${raw.nodeId}`;
    // In-process frames can appear in their parent's tree too.
    if (visited.has(id) || depth > MAX_DEPTH) return [];
    visited.add(id);
    const role = roleOf(raw);
    if (SKIPPED_ROLES.has(role)) return [];
    const children = () => {
      const nested = (raw.childIds ?? []).flatMap((childId) => {
        const child = byId.get(childId);
        return child ? visit(frame, byId, child, depth + 1) : [];
      });
      const owned =
        raw.backendDOMNodeId === undefined
          ? []
          : (hosted.get(`${frame.key}:${raw.backendDOMNodeId}`) ?? []).flatMap((child) =>
              visitFrame(child, depth + 1),
            );
      return [...nested, ...owned];
    };
    if (raw.ignored || HOISTED_ROLES.has(role)) return children();
    const name =
      role === "text" && typeof raw.name?.value === "string"
        ? raw.name.value.slice(0, TEXT_MAX_CHARS)
        : text(raw.name?.value);
    if (role === "text" && name === undefined) return [];
    if (count >= maxNodes) {
      truncated = true;
      return [];
    }
    count += 1;
    const properties = new Map(
      raw.properties?.map((property) => [property.name, property.value.value]),
    );
    const editable = properties.has("editable") || EDITABLE_ROLES.has(role);
    const value = editable
      ? fieldValue(raw.value?.value)
      : text(raw.value?.value, PREVIEW_ACCESSIBILITY_VALUE_MAX_CHARS);
    const secret =
      raw.backendDOMNodeId !== undefined && frame.secretNodes.has(raw.backendDOMNodeId);
    const hidden = secret || (value !== undefined && MASKED_VALUE.test(value.trim()));
    const level = properties.get("level");
    const node: { -readonly [K in keyof PreviewAccessibilityNode]: PreviewAccessibilityNode[K] } = {
      id,
      role,
    };
    if (name !== undefined) node.name = name;
    const description = text(raw.description?.value);
    if (description !== undefined && role !== "text") node.description = description;
    if (hidden) node.protected = true;
    else if (value !== undefined && (editable || value !== name)) node.value = value;
    const url = text(properties.get("url"), 2_048);
    if (url !== undefined && role === "link") node.url = url;
    if (typeof level === "number" && Number.isInteger(level) && level >= 0) node.level = level;
    const checked = tristate(properties.get("checked"));
    if (checked !== undefined) node.checked = checked;
    const pressed = tristate(properties.get("pressed"));
    if (pressed !== undefined) node.pressed = pressed;
    if (properties.has("expanded")) node.expanded = truthy(properties.get("expanded"));
    if (properties.has("selected")) node.selected = truthy(properties.get("selected"));
    for (const flag of ["disabled", "readonly", "required", "focused", "multiline"] as const) {
      if (truthy(properties.get(flag))) node[flag] = true;
    }
    const invalid = properties.get("invalid");
    if (invalid !== undefined && invalid !== "false" && invalid !== false) node.invalid = true;
    if (editable) node.editable = true;
    if (role !== "text" && !hidden) {
      const kids = children();
      if (kids.length > 0) node.children = kids;
    }
    if (raw.backendDOMNodeId !== undefined) {
      targets.set(id, {
        key: frame.key,
        backendNodeId: raw.backendDOMNodeId,
        role,
        disabled: node.disabled === true,
        readonly: node.readonly === true,
        editable,
      });
    }
    return [node];
  };

  const [main] = frames;
  const nodes = main ? visitFrame(main, 0) : [];
  const root =
    nodes.length === 1 && nodes[0]!.role === "document"
      ? nodes[0]!
      : nodes.length === 0
        ? null
        : { id: `${main!.key}.root`, role: "document", children: nodes };
  return { root, targets, truncated };
}

/** Strings a viewer reads aloud; keep them short and actionable. */
export const AccessibilityNotice = {
  stale: "The page changed. Try again.",
  disabled: "That control is unavailable.",
  notActivatable: "That item cannot be activated.",
  notEditable: "That field cannot be edited.",
  notController: "Take control of the browser to use the page.",
  unavailable: "The accessible view could not read this page.",
} as const;

// Runs as the element's method with a user gesture, so popups and media still work.
const ACTIVATE_FUNCTION = `function () {
  const select = this.tagName === "OPTION" ? this.closest("select") : null;
  if (select) {
    if (select.disabled || this.disabled) return false;
    if (select.multiple) this.selected = !this.selected;
    else if (!this.selected) this.selected = true;
    else return true;
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }
  if (typeof this.focus === "function") this.focus({ preventScroll: true });
  if (typeof this.click === "function") this.click();
  else this.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  return true;
}`;
const SELECT_CONTENTS_FUNCTION = `function () {
  if (typeof this.select === "function" && "value" in this) return this.select();
  const range = this.ownerDocument.createRange();
  range.selectNodeContents(this);
  const selection = this.ownerDocument.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}`;

const SETTLE_MS = 300;
const MIN_CAPTURE_INTERVAL_MS = 1_000;
const REDELIVER_MS = 250;

interface Capture {
  readonly document: PreviewAccessibilityDocument;
  readonly json: string;
  readonly targets: ReadonlyMap<string, AccessibilityTarget>;
}

interface Subscriber {
  readonly offer: (document: PreviewAccessibilityDocument) => boolean;
  pending: boolean;
}

interface FrameDocument {
  readonly key: string;
  readonly session: CDPSession;
  readonly frameId: string;
  readonly parentId: string | undefined;
}

interface FrameTreeNode {
  readonly frame: { readonly id: string; readonly parentId?: string; readonly loaderId: string };
  readonly childFrames?: ReadonlyArray<FrameTreeNode>;
}

/**
 * One tab's opt-in semantic mirror. Nothing touches the Accessibility domain
 * until the first viewer subscribes, and the last one leaving releases it.
 */
export class ServerBrowserAccessibility {
  private readonly page: Page;
  private readonly onError: (cause: unknown) => void;
  private readonly subscribers = new Map<string, Subscriber>();
  private readonly sessions = new Map<string, CDPSession>();
  private readonly frameSessions = new Map<Frame, Promise<string | null>>();
  private ready: Promise<void> | null = null;
  private main: CDPSession | null = null;
  private run = 0;
  private sessionSerial = 0;
  private version = 0;
  /** Bumped by any frame navigation; a capture that spans one cannot be acted on. */
  private frameChanges = 0;
  private latest: Capture | null = null;
  private chain: Promise<void> = Promise.resolve();
  private queued: Promise<void> | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private redeliverTimer: ReturnType<typeof setTimeout> | null = null;
  private lastCaptureAt = 0;
  private closed = false;

  constructor(page: Page, onError: (cause: unknown) => void = constVoid) {
    this.page = page;
    this.onError = onError;
  }

  get active() {
    return this.main !== null;
  }

  async subscribe(id: string, offer: Subscriber["offer"]) {
    if (this.closed) return;
    this.subscribers.set(id, { offer, pending: true });
    this.ready ??= this.start();
    try {
      await this.ready;
    } catch (cause) {
      await this.unsubscribe(id);
      throw cause;
    }
    if (!this.subscribers.has(id)) return;
    if (this.latest) this.deliver();
    else await this.refresh();
  }

  /** Resolves once the last subscriber's domain and sessions are released. */
  async unsubscribe(id: string) {
    if (!this.subscribers.delete(id) || this.subscribers.size > 0) return;
    await this.stop();
  }

  async close() {
    this.closed = true;
    this.subscribers.clear();
    await this.stop();
  }

  /** Coalesces page changes into at most one capture per interval. */
  readonly invalidate = () => {
    if (!this.main || this.settleTimer !== null) return;
    const delay = Math.max(SETTLE_MS, this.lastCaptureAt + MIN_CAPTURE_INTERVAL_MS - Date.now());
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      void this.refresh();
    }, delay);
  };

  /** Resolves after a capture that started after this call. */
  refresh(): Promise<void> {
    if (this.queued) return this.queued;
    const next = this.chain.then(() => {
      this.queued = null;
      return this.captureOnce();
    });
    this.queued = next;
    this.chain = next.catch(constVoid);
    return next;
  }

  /** Callers hold the tab's human control. Returns a notice when the action is refused. */
  async act(action: PreviewAccessibilityAction): Promise<string | null> {
    const latest = this.latest;
    const main = this.main;
    if (!latest || !main || latest.document.document !== action.document) {
      return AccessibilityNotice.stale;
    }
    const target = latest.targets.get(action.node);
    const session = target ? this.sessions.get(target.key) : undefined;
    if (!target || !session) return AccessibilityNotice.stale;
    if (target.disabled) return AccessibilityNotice.disabled;
    const frameChanges = this.frameChanges;
    const run = this.run;
    const interrupted = new Error(AccessibilityNotice.stale);
    const isCurrent = () =>
      this.run === run &&
      this.frameChanges === frameChanges &&
      this.main === main &&
      this.sessions.get(target.key) === session;
    const assertCurrent = () => {
      if (!isCurrent()) {
        throw interrupted;
      }
    };
    const backendNodeId = target.backendNodeId;
    try {
      if (action.action === "activate") {
        if (!ACTIVATABLE_ROLES.has(target.role)) return AccessibilityNotice.notActivatable;
        await session.send("DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(constVoid);
        assertCurrent();
        await callOn(session, backendNodeId, ACTIVATE_FUNCTION, assertCurrent);
      } else {
        if (!target.editable || target.readonly) return AccessibilityNotice.notEditable;
        await session.send("DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(constVoid);
        assertCurrent();
        await session.send("DOM.focus", { backendNodeId });
        assertCurrent();
        await callOn(session, backendNodeId, SELECT_CONTENTS_FUNCTION, assertCurrent);
        assertCurrent();
        // Real input events keep framework-controlled fields in sync.
        if (action.value) await main.send("Input.insertText", { text: action.value });
        else await pressKey(main, "Backspace", 8, undefined, isCurrent);
        assertCurrent();
        if (action.submit) await pressKey(main, "Enter", 13, "\r", isCurrent);
      }
    } catch (cause) {
      if (cause === interrupted) return AccessibilityNotice.stale;
      throw cause;
    }
    // Outside the caller's control queue, so a large page never delays the next input.
    void this.refresh();
    return null;
  }

  private async start() {
    const run = ++this.run;
    const session = await this.page.context().newCDPSession(this.page);
    if (run !== this.run) {
      void session.detach().catch(constVoid);
      return;
    }
    this.main = session;
    this.sessions.set("0", session);
    this.page.on("framenavigated", this.onFrameNavigated);
    this.page.on("framedetached", this.onFrameDetached);
    this.page.on("domcontentloaded", this.invalidate);
    this.page.on("load", this.invalidate);
    await this.watch(session);
  }

  /** Each out-of-process frame reports its own semantic changes. */
  private watch(session: CDPSession) {
    session.on("Accessibility.nodesUpdated", this.invalidate);
    session.on("Accessibility.loadComplete", this.invalidate);
    return session.send("Accessibility.enable").then(constVoid, constVoid);
  }

  private async release(session: CDPSession) {
    session.off("Accessibility.nodesUpdated", this.invalidate);
    session.off("Accessibility.loadComplete", this.invalidate);
    await session.send("Accessibility.disable").catch(constVoid);
    await session.detach().catch(constVoid);
  }

  private async stop() {
    this.run += 1;
    this.ready = null;
    this.latest = null;
    this.queued = null;
    if (this.settleTimer !== null) clearTimeout(this.settleTimer);
    if (this.redeliverTimer !== null) clearTimeout(this.redeliverTimer);
    this.settleTimer = this.redeliverTimer = null;
    this.page.off("framenavigated", this.onFrameNavigated);
    this.page.off("framedetached", this.onFrameDetached);
    this.page.off("domcontentloaded", this.invalidate);
    this.page.off("load", this.invalidate);
    this.main = null;
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    this.frameSessions.clear();
    await Promise.all(sessions.map((session) => this.release(session)));
  }

  private readonly onFrameNavigated = (frame: Frame) => {
    if (frame === this.page.mainFrame()) this.latest = null;
    else this.dropFrameSession(frame);
    this.forgetTargets();
  };

  private readonly onFrameDetached = (frame: Frame) => {
    this.dropFrameSession(frame);
    this.forgetTargets();
  };

  /**
   * Same-process frames share their parent's node ids, so any frame change may
   * leave an id naming a replaced element. Actions wait for the next capture.
   */
  private forgetTargets() {
    this.frameChanges += 1;
    if (this.latest) this.latest = { ...this.latest, targets: new Map() };
    this.invalidate();
  }

  private dropFrameSession(frame: Frame) {
    const entry = this.frameSessions.get(frame);
    if (!entry) return;
    this.frameSessions.delete(frame);
    void entry
      .then((key) => {
        const session = key === null ? undefined : this.sessions.get(key);
        if (key !== null) this.sessions.delete(key);
        return session && this.release(session);
      })
      .catch(constVoid);
  }

  /** Out-of-process frames need their own session; in-process ones are read through their parent's. */
  private frameSession(frame: Frame) {
    let entry = this.frameSessions.get(frame);
    if (!entry) {
      const run = this.run;
      entry = this.page
        .context()
        .newCDPSession(frame)
        .then(
          async (session) => {
            if (run !== this.run) {
              void session.detach().catch(constVoid);
              return null;
            }
            const key = String(++this.sessionSerial);
            this.sessions.set(key, session);
            await this.watch(session);
            return key;
          },
          () => null,
        );
      this.frameSessions.set(frame, entry);
    }
    return entry;
  }

  private async captureOnce() {
    const run = this.run;
    const frameChanges = this.frameChanges;
    const main = this.main;
    if (!main) return;
    this.lastCaptureAt = Date.now();
    const captured = await this.capture(main).catch((cause: unknown) => {
      this.onError(cause);
      return null;
    });
    if (!captured || run !== this.run || !captured.root) return;
    const targets =
      frameChanges === this.frameChanges
        ? captured.targets
        : new Map<string, AccessibilityTarget>();
    const json = JSON.stringify([captured.token, captured.truncated, captured.root]);
    if (this.latest?.json === json) {
      this.latest = { ...this.latest, targets };
      return;
    }
    this.latest = {
      document: {
        document: captured.token,
        version: ++this.version,
        truncated: captured.truncated,
        root: captured.root,
      },
      json,
      targets,
    };
    for (const subscriber of this.subscribers.values()) subscriber.pending = true;
    this.deliver();
  }

  /** Viewer queues drop under backpressure; retry with whatever is newest then. */
  private deliver() {
    const latest = this.latest;
    if (!latest) return;
    let waiting = false;
    for (const subscriber of this.subscribers.values()) {
      if (subscriber.pending) subscriber.pending = !subscriber.offer(latest.document);
      waiting ||= subscriber.pending;
    }
    if (waiting && this.redeliverTimer === null) {
      this.redeliverTimer = setTimeout(() => {
        this.redeliverTimer = null;
        this.deliver();
      }, REDELIVER_MS);
    }
  }

  private async capture(main: CDPSession) {
    const documents = new Map<string, FrameDocument>();
    const walk = (tree: FrameTreeNode, key: string, session: CDPSession) => {
      documents.set(tree.frame.id, {
        key,
        session,
        frameId: tree.frame.id,
        parentId: tree.frame.parentId,
      });
      for (const child of tree.childFrames ?? []) walk(child, key, session);
    };
    const { frameTree } = (await main.send("Page.getFrameTree")) as { frameTree: FrameTreeNode };
    const token = `${this.run}:${frameTree.frame.loaderId}`;
    walk(frameTree, "0", main);
    for (const frame of this.page.frames()) {
      if (frame === this.page.mainFrame()) continue;
      const key = await this.frameSession(frame);
      const session = key === null ? undefined : this.sessions.get(key);
      if (!key || !session) continue;
      const own = (await session.send("Page.getFrameTree").catch(() => null)) as {
        frameTree: FrameTreeNode;
      } | null;
      if (own) walk(own.frameTree, key, session);
    }
    const trees = await Promise.all(
      [...documents.values()].map(async (document): Promise<AccessibilityFrameTree | null> => {
        const tree = await document.session
          .send("Accessibility.getFullAXTree", { frameId: document.frameId })
          .catch(() => null);
        if (!tree) return null;
        let owner: AccessibilityFrameTree["owner"];
        if (document.parentId !== undefined) {
          const parent = documents.get(document.parentId);
          const element = parent
            ? await parent.session
                .send("DOM.getFrameOwner", { frameId: document.frameId })
                .catch(() => null)
            : null;
          if (!parent || !element) return null;
          owner = { key: parent.key, backendNodeId: element.backendNodeId };
        }
        const nodes = tree.nodes as ReadonlyArray<RawAccessibilityNode>;
        return {
          key: document.key,
          nodes,
          ...(owner ? { owner } : {}),
          secretNodes: await secretFields(document.session, nodes),
        };
      }),
    );
    const [main_, ...rest] = trees;
    if (!main_) throw new Error("The page's accessibility tree is unavailable.");
    const built = buildAccessibilityTree([main_, ...rest.filter((tree) => tree !== null)]);
    return {
      token,
      ...built,
      truncated:
        built.truncated ||
        trees.some((tree) => tree === null) ||
        documents.size < this.page.frames().length,
    };
  }
}

/** Fields we cannot inspect count as secret, so their values never leave the server. */
async function secretFields(session: CDPSession, nodes: ReadonlyArray<RawAccessibilityNode>) {
  const ids = valueFieldIds(nodes);
  const secret = new Set(ids.slice(MAX_SECRET_CHECKS));
  await Promise.all(
    ids.slice(0, MAX_SECRET_CHECKS).map(async (backendNodeId) => {
      const described = await session.send("DOM.describeNode", { backendNodeId }).catch(() => null);
      if (!described || isSecretField(described.node)) secret.add(backendNodeId);
    }),
  );
  return secret;
}

async function callOn(
  session: CDPSession,
  backendNodeId: number,
  functionDeclaration: string,
  assertCurrent: () => void,
) {
  const { object } = await session.send("DOM.resolveNode", { backendNodeId });
  if (!object.objectId) throw new Error("The element is gone.");
  try {
    assertCurrent();
    await session.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration,
      userGesture: true,
      returnByValue: true,
    });
  } finally {
    void session.send("Runtime.releaseObject", { objectId: object.objectId }).catch(constVoid);
  }
}

async function pressKey(
  session: CDPSession,
  key: string,
  keyCode: number,
  text: string | undefined,
  isCurrent: () => boolean,
) {
  await session.send("Input.dispatchKeyEvent", {
    type: text ? "keyDown" : "rawKeyDown",
    key,
    code: key,
    windowsVirtualKeyCode: keyCode,
    ...(text ? { text, unmodifiedText: text } : {}),
  });
  if (!isCurrent()) return;
  await session.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key,
    code: key,
    windowsVirtualKeyCode: keyCode,
  });
}
