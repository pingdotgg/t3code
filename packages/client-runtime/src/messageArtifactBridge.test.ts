import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createMessageArtifactHost,
  createSandboxedMessageArtifactDocument,
  MESSAGE_ARTIFACT_STYLE_VARIABLES,
  messageArtifactMessageInjection,
  readMessageArtifactMemory,
  type MessageArtifactHostContext,
  type MessageArtifactStyleVariable,
} from "./messageArtifacts.ts";

/*
 * Runs the page scripts of a built artifact document against the host, the way the web iframe and
 * the React Native WebView do. No DOM library is installed in this repo, so the page is a small
 * stand-in with only what the bridge touches: listeners, form fields, links, the root element's
 * size and style, animation frames and resize observers.
 */

type Listener = (event: object) => void;

class FakeEventTarget {
  private readonly listeners = new Map<string, Listener[]>();

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  dispatchEvent(event: Event): boolean {
    this.emit(event.type, event);
    return true;
  }

  emit(type: string, event: object): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class FakeElement {
  parentElement: FakeElement | null = null;
  readonly tagName: string;
  readonly attributes: Readonly<Record<string, string>>;

  constructor(tagName: string, attributes: Readonly<Record<string, string>> = {}) {
    this.tagName = tagName;
    this.attributes = attributes;
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  append(...children: FakeElement[]): this {
    for (const child of children) child.parentElement = this;
    return this;
  }

  closest(selector: string): FakeElement | null {
    if (selector !== "a[href]") throw new Error(`The fake page does not support ${selector}.`);
    if (this.tagName === "a" && "href" in this.attributes) return this;
    return this.parentElement?.closest(selector) ?? null;
  }
}

class FakeField extends FakeElement {
  readonly type: string;
  readonly name: string;
  readonly id = "";
  readonly multiple: boolean;
  readonly options: Array<{ readonly value: string; selected: boolean }>;
  value: string;
  checked: boolean;
  ownerDocument: FakeEventTarget | null = null;

  constructor(
    tagName: string,
    init: {
      readonly type: string;
      readonly name: string;
      readonly value?: string;
      readonly checked?: boolean;
      readonly options?: ReadonlyArray<string>;
    },
  ) {
    super(tagName);
    this.type = init.type;
    this.name = init.name;
    this.value = init.value ?? "";
    this.checked = init.checked ?? false;
    this.multiple = init.type === "select-multiple";
    this.options = (init.options ?? []).map((value) => ({ value, selected: false }));
  }

  get selectedOptions() {
    return this.options.filter((option) => option.selected);
  }

  dispatchEvent(event: Event): boolean {
    this.ownerDocument?.emit(event.type, event);
    return true;
  }
}

interface PostedMessage {
  readonly id?: string | number;
  readonly method?: string;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly result?: unknown;
  readonly error?: unknown;
}

function hostContext(theme: "light" | "dark", textColor: string): MessageArtifactHostContext {
  const variables = Object.fromEntries(
    MESSAGE_ARTIFACT_STYLE_VARIABLES.map((name) => [name, "initial"]),
  ) as Record<MessageArtifactStyleVariable, string>;
  return {
    theme,
    platform: "web",
    containerDimensions: { maxHeight: 720 },
    styles: { variables: { ...variables, "--color-text-primary": textColor } },
  };
}

const darkContext = hostContext("dark", "#eeeeee");

/** A form with every kind of field the bridge remembers, and two it must never read. */
function form() {
  return {
    title: new FakeField("input", { type: "text", name: "title" }),
    tagA: new FakeField("input", { type: "checkbox", name: "tags", value: "a" }),
    tagB: new FakeField("input", { type: "checkbox", name: "tags", value: "b" }),
    small: new FakeField("input", { type: "radio", name: "size", value: "s", checked: true }),
    medium: new FakeField("input", { type: "radio", name: "size", value: "m" }),
    fruits: new FakeField("select", {
      type: "select-multiple",
      name: "fruits",
      options: ["apple", "pear", "plum"],
    }),
    upload: new FakeField("input", { type: "file", name: "upload" }),
    secret: new FakeField("input", { type: "password", name: "secret" }),
  };
}

function openArtifact(options: {
  readonly key: string;
  readonly transport: "web" | "mobile";
  readonly fields?: ReadonlyArray<FakeField>;
  readonly source?: string;
  readonly openLink?: (url: string) => boolean | Promise<boolean>;
}) {
  const posted: PostedMessage[] = [];
  const received: PostedMessage[] = [];
  const deliveries: Array<() => void> = [];
  const frames: Array<() => void> = [];
  const resizeCallbacks: Array<() => void> = [];
  const styles = new Map<string, string>();
  const fields = options.fields ?? [];
  let height = 0;

  const documentElement = {
    style: {
      colorScheme: "",
      setProperty: (name: string, value: string) => void styles.set(name, value),
    },
    dataset: {} as Record<string, string>,
    getBoundingClientRect: () => ({ height }),
  };
  const document = Object.assign(new FakeEventTarget(), {
    readyState: "loading",
    baseURI: "about:srcdoc",
    documentElement,
    body: {},
    querySelectorAll: (selector: string) => {
      if (selector !== "input, textarea, select") {
        throw new Error(`The fake page does not support ${selector}.`);
      }
      return fields;
    },
  });
  for (const field of fields) field.ownerDocument = document;

  const window = Object.assign(new FakeEventTarget(), {
    innerWidth: 400,
    parent: null as unknown,
    ReactNativeWebView: undefined as unknown,
    t3: undefined as unknown,
  });
  const onHeight = vi.fn();
  const onUnload = vi.fn();
  const host = createMessageArtifactHost({
    key: options.key,
    context: darkContext,
    send: (message) =>
      deliveries.push(() => {
        received.push(message);
        if (options.transport === "web") {
          window.emit("message", { data: structuredClone(message) });
        } else {
          run(messageArtifactMessageInjection(message));
        }
      }),
    onHeight,
    openLink: options.openLink ?? (() => true),
    onUnload,
  });
  // Both transports deliver asynchronously, like `postMessage` and the React Native bridge.
  if (options.transport === "web") {
    window.parent = {
      postMessage: (message: PostedMessage) =>
        deliveries.push(() => {
          const copy = structuredClone(message);
          posted.push(copy);
          host.receive(copy);
        }),
    };
  } else {
    window.parent = window;
    window.ReactNativeWebView = {
      postMessage: (data: string) =>
        deliveries.push(() => {
          posted.push(JSON.parse(data) as PostedMessage);
          host.receive(data);
        }),
    };
  }

  class FakeResizeObserver {
    constructor(callback: () => void) {
      resizeCallbacks.push(callback);
    }
    observe() {}
  }
  const pageConsole = { warn: vi.fn() };

  function run(script: string): void {
    new Function(
      "window",
      "document",
      "requestAnimationFrame",
      "ResizeObserver",
      "Element",
      "console",
      script,
    )(
      window,
      document,
      (callback: () => void) => frames.push(callback),
      FakeResizeObserver,
      FakeElement,
      pageConsole,
    );
  }

  const flush = () => {
    for (let round = 0; deliveries.length > 0 || frames.length > 0; round += 1) {
      if (round > 50) throw new Error("The page and host kept messaging each other.");
      for (const delivery of deliveries.splice(0)) delivery();
      for (const frame of frames.splice(0)) frame();
    }
  };

  const html = createSandboxedMessageArtifactDocument(options.source ?? "", {
    state: readMessageArtifactMemory(options.key)?.state,
  });
  for (const [, script] of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gu)) {
    run(script ?? "");
  }

  return {
    window,
    document,
    host,
    posted,
    received,
    styles,
    onHeight,
    onUnload,
    pageConsole,
    flush,
    run,
    load() {
      document.readyState = "interactive";
      document.emit("DOMContentLoaded", { type: "DOMContentLoaded" });
      flush();
    },
    resize(nextHeight: number) {
      height = nextHeight;
      for (const callback of resizeCallbacks) callback();
      flush();
    },
    /** Returns whether the page prevented the default action. */
    click(target: FakeElement): boolean {
      let prevented = false;
      document.emit("click", { type: "click", target, preventDefault: () => (prevented = true) });
      flush();
      return prevented;
    },
    edit(field: FakeField, change: (field: FakeField) => void) {
      change(field);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    },
    sent(method: string) {
      return posted.filter((message) => message.method === method);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("artifact page bridge", () => {
  it.each(["web", "mobile"] as const)(
    "completes the handshake and applies theme changes over %s",
    (transport) => {
      const page = openArtifact({ key: `bridge:handshake:${transport}`, transport });
      page.load();

      const [initialize] = page.sent("ui/initialize");
      expect(initialize?.id).toEqual(expect.any(String));
      expect(page.received[0]).toMatchObject({
        id: initialize?.id,
        result: { hostContext: darkContext },
      });
      expect(page.sent("ui/notifications/initialized")).toHaveLength(1);
      expect(page.styles.get("--color-text-primary")).toBe("#eeeeee");
      expect(page.document.documentElement.dataset.theme).toBe("dark");

      page.host.updateContext(hostContext("light", "#111111"));
      page.flush();
      expect(page.styles.get("--color-text-primary")).toBe("#111111");
      expect(page.document.documentElement.dataset.theme).toBe("light");

      // An MCP Apps SDK in the page shares the channel and can ping the host.
      page.run(
        transport === "web"
          ? "window.parent.postMessage({ jsonrpc: '2.0', id: 'app:1', method: 'ping' }, '*')"
          : "window.ReactNativeWebView.postMessage(JSON.stringify({ jsonrpc: '2.0', id: 'app:1', method: 'ping' }))",
      );
      page.flush();
      expect(page.received.at(-1)).toEqual({ jsonrpc: "2.0", id: "app:1", result: {} });
    },
  );

  it("reports content height when it changes, once per change", () => {
    const page = openArtifact({ key: "bridge:size", transport: "web" });
    page.resize(240);
    page.load();
    page.resize(240);
    page.resize(480);
    page.resize(480);

    expect(page.sent("ui/notifications/size-changed").map((message) => message.params)).toEqual([
      { width: 400, height: 240 },
      { width: 400, height: 480 },
    ]);
    expect(page.onHeight.mock.calls).toEqual([[240], [480]]);
  });

  it("turns link clicks into host requests the host may refuse or rate-limit", () => {
    vi.useFakeTimers();
    let userActivated = false;
    const openLink = vi.fn(() => userActivated);
    const page = openArtifact({ key: "bridge:links", transport: "web", openLink });
    page.load();
    const docs = new FakeElement("a", { href: "https://t3.codes/docs?tab=1" });
    const chartShape = new FakeElement("path");
    new FakeElement("svg").append(
      new FakeElement("a", { href: "https://example.com/chart" }).append(chartShape),
    );
    const heading = new FakeElement("a", { href: "#results" });
    const answers = () => {
      const linkRequestIds = new Set(page.sent("ui/open-link").map((message) => message.id));
      return page.received.filter((message) => linkRequestIds.has(message.id));
    };

    expect(page.click(docs)).toBe(true);
    vi.advanceTimersByTime(1_000);
    userActivated = true;
    expect(page.click(chartShape)).toBe(true);
    expect(page.click(docs)).toBe(true);
    vi.advanceTimersByTime(1_000);
    expect(page.click(docs)).toBe(true);
    expect(page.click(heading)).toBe(false);

    expect(page.sent("ui/open-link").map((message) => message.params?.url)).toEqual([
      "https://t3.codes/docs?tab=1",
      "https://example.com/chart",
      "https://t3.codes/docs?tab=1",
      "https://t3.codes/docs?tab=1",
    ]);
    expect(openLink.mock.calls).toEqual([
      ["https://t3.codes/docs?tab=1"],
      ["https://example.com/chart"],
      ["https://t3.codes/docs?tab=1"],
    ]);
    expect(answers().map((message) => ("result" in message ? "opened" : "refused"))).toEqual([
      "refused",
      "opened",
      "refused",
      "opened",
    ]);
  });

  it("reports form values after typing settles and restores them in a rebuilt page", () => {
    vi.useFakeTimers();
    const key = "bridge:fields";
    const first = form();
    const page = openArtifact({ key, transport: "web", fields: Object.values(first) });
    page.load();

    page.edit(first.title, (field) => (field.value = "Quarterly"));
    page.edit(first.tagB, (field) => (field.checked = true));
    page.edit(first.medium, (field) => {
      field.checked = true;
      first.small.checked = false;
    });
    page.edit(first.fruits, (field) => {
      for (const option of field.options) option.selected = option.value !== "plum";
    });
    page.edit(first.upload, (field) => (field.value = "C:\\fakepath\\photo.png"));
    page.edit(first.secret, (field) => (field.value = "swordfish"));
    vi.advanceTimersByTime(149);
    page.flush();
    expect(page.sent("t3/notifications/state-changed")).toEqual([]);
    vi.advanceTimersByTime(1);
    page.flush();

    expect(page.sent("t3/notifications/state-changed").map((message) => message.params)).toEqual([
      {
        fields: {
          title: "Quarterly",
          "checkbox:tags:a": "",
          "checkbox:tags:b": "1",
          "radio:size": "m",
          fruits: '["apple","pear"]',
        },
      },
    ]);

    const second = form();
    openArtifact({ key, transport: "web", fields: Object.values(second) }).load();
    expect({
      title: second.title.value,
      tags: [second.tagA.checked, second.tagB.checked],
      size: [second.small.checked, second.medium.checked],
      fruits: second.fruits.options.map((option) => option.selected),
      upload: second.upload.value,
      secret: second.secret.value,
    }).toEqual({
      title: "Quarterly",
      tags: [false, true],
      size: [false, true],
      fruits: [true, true, false],
      upload: "",
      secret: "",
    });
  });

  it("keeps JSON passed to window.t3.setState for the rebuilt page, and rejects oversize state", () => {
    vi.useFakeTimers();
    const key = "bridge:set-state";
    const page = openArtifact({
      key,
      transport: "mobile",
      source: "<script>window.t3.setState({ step: 2, done: ['intro'] })</script>",
    });
    page.load();
    vi.advanceTimersByTime(150);
    page.run("window.t3.setState({ notes: 'x'.repeat(64000) })");
    vi.advanceTimersByTime(150);
    page.flush();

    expect(page.sent("t3/notifications/state-changed").map((message) => message.params)).toEqual([
      { fields: {}, data: '{"step":2,"done":["intro"]}' },
    ]);
    expect(page.pageConsole.warn).toHaveBeenCalledOnce();
    expect(openArtifact({ key, transport: "mobile" }).window.t3).toMatchObject({
      state: { step: 2, done: ["intro"] },
    });
  });

  it.each(["web", "mobile"] as const)(
    "tells the host when the page leaves its document over %s",
    (transport) => {
      const page = openArtifact({ key: `bridge:unload:${transport}`, transport });
      page.load();
      page.window.emit("pagehide", { type: "pagehide" });
      page.flush();

      expect(page.sent("t3/notifications/unloading")).toHaveLength(1);
      expect(page.onUnload).toHaveBeenCalledOnce();
    },
  );
});
