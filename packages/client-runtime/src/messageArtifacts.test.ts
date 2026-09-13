import { ChatAttachmentId } from "@t3tools/contracts";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createMessageArtifactHost,
  createSandboxedMessageArtifactDocument,
  fetchMessageArtifactHtml,
  MESSAGE_ARTIFACT_STYLE_VARIABLES,
  messageArtifactParts,
  readMessageArtifactMemory,
  rememberMessageArtifact,
  setMessageArtifactHeightStore,
  splitMessageArtifactMarkdown,
  type MessageArtifactHostContext,
  type MessageArtifactStyleVariable,
} from "./messageArtifacts.ts";

const attachmentId = ChatAttachmentId.make("thread-00000000-0000-0000-0000-000000000000-txt");

afterEach(() => {
  vi.useRealTimers();
});

describe("message artifact parts", () => {
  const text = ["```t3-artifact", "a.html", "```", "", "```t3-artifact", "b.html", "```"].join(
    "\n",
  );

  it("shows every finished fence, with a copy only where position and path match", () => {
    const artifacts = [{ sourceOrdinal: 1, sourcePath: "b.html", attachmentId }];

    expect(messageArtifactParts(text, false, artifacts)).toEqual([
      expect.objectContaining({ path: "a.html", sourceOrdinal: 0, attachmentId: null }),
      expect.objectContaining({ path: "b.html", sourceOrdinal: 1, attachmentId }),
    ]);
    expect(messageArtifactParts(text, true, artifacts)).toEqual([]);
    expect(
      messageArtifactParts(text, false, [{ sourceOrdinal: 1, sourcePath: "a.html", attachmentId }]),
    ).toEqual([
      expect.objectContaining({ attachmentId: null }),
      expect.objectContaining({ attachmentId: null }),
    ]);
  });

  it("splits a message around artifacts with offsets into the whole message", () => {
    const message = "Before\n```t3-artifact\ncharts/a.html\n```\nAfter";
    const artifacts = [{ sourceOrdinal: 0, sourcePath: "charts/a.html", attachmentId }];
    const segments = splitMessageArtifactMarkdown(message, false, artifacts);

    expect(segments.map((segment) => segment.kind)).toEqual([
      "markdown",
      "message-artifact",
      "markdown",
    ]);
    const after = segments[2];
    expect(after?.kind === "markdown" ? message.slice(after.sourceOffset) : null).toBe("\nAfter");
    expect(
      splitMessageArtifactMarkdown(message, true, artifacts).map((segment) => segment.kind),
    ).toEqual(["markdown"]);
  });
});

describe("message artifact parts and markdown positions", () => {
  interface MarkdownNode {
    readonly type: string;
    readonly lang?: string | null | undefined;
    readonly position?: { readonly start: { readonly offset?: number | undefined } } | undefined;
    readonly children?: ReadonlyArray<MarkdownNode>;
  }
  const codeNodes = (node: MarkdownNode): MarkdownNode[] =>
    node.type === "code" ? [node] : (node.children ?? []).flatMap(codeNodes);

  // Web swaps a rendered code block for its artifact when the block starts inside a part.
  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("puts each artifact code block, and no other, inside its part (%s)", (_name, eol) => {
    const text = [
      "Intro with `inline` code.",
      "",
      "```t3-artifact",
      "charts/a.html",
      "```",
      "",
      "```ts",
      "const example = 1;",
      "```",
      "",
      "- item",
      "",
      "~~~~ t3-artifact",
      "b.html",
      "~~~~",
      "Between",
      "```T3-Artifact",
      "reports/c.htm",
      "```",
      "Outro",
    ].join(eol);
    const parts = messageArtifactParts(text, false, []);
    const partIndexes = codeNodes(unified().use(remarkParse).parse(text)).map((node) => {
      const offset = node.position?.start.offset ?? -1;
      return [node.lang, parts.findIndex((part) => offset >= part.start && offset < part.end)];
    });

    expect(parts.map((part) => part.path)).toEqual(["charts/a.html", "b.html", "reports/c.htm"]);
    expect(partIndexes).toEqual([
      ["t3-artifact", 0],
      ["ts", -1],
      ["t3-artifact", 1],
      ["T3-Artifact", 2],
    ]);
  });
});

describe("remembered artifacts", () => {
  afterEach(() => {
    setMessageArtifactHeightStore(null);
  });

  it("keeps the latest 200 heights in the host store, written once per burst", () => {
    vi.useFakeTimers();
    let saved: string | null = null;
    const write = vi.fn((value: string) => {
      saved = value;
    });
    setMessageArtifactHeightStore({ read: () => saved, write });

    for (let index = 0; index < 205; index += 1) {
      rememberMessageArtifact(`height:${index}`, { height: 100 + index });
    }
    expect(write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(write).toHaveBeenCalledOnce();

    // A restart reads the store again; the first entries are beyond the in-memory limit.
    setMessageArtifactHeightStore({ read: () => saved, write });
    expect(readMessageArtifactMemory("height:4")).toBeUndefined();
    expect(readMessageArtifactMemory("height:5")).toEqual({ height: 105 });
    expect(readMessageArtifactMemory("height:204")).toEqual({ height: 304 });
  });

  it("ignores unreadable, malformed and out-of-range stored heights", () => {
    const stores = [
      () => {
        throw new Error("Storage is disabled.");
      },
      () => "{not json",
      () => JSON.stringify([["height:bad", 5_000], ["height:bad"], "height:bad"]),
    ];
    for (const read of stores) {
      setMessageArtifactHeightStore({ read, write: () => undefined });
      expect(readMessageArtifactMemory("height:bad")).toBeUndefined();
    }
  });

  it("keeps fetched copies for remounts, dropping the least recently used past 8 MB", () => {
    const copy = "x".repeat(3 * 1024 * 1024);
    rememberMessageArtifact("source:a", { source: copy, hidden: true });
    rememberMessageArtifact("source:b", { source: copy });
    rememberMessageArtifact("source:a", { height: 200 });
    rememberMessageArtifact("source:c", { source: copy });

    expect(readMessageArtifactMemory("source:b")).toEqual({});
    expect(readMessageArtifactMemory("source:a")).toEqual({
      source: copy,
      hidden: true,
      height: 200,
    });
    expect(readMessageArtifactMemory("source:c")?.source).toBe(copy);
  });
});

const context: MessageArtifactHostContext = {
  theme: "dark",
  platform: "web",
  containerDimensions: { maxHeight: 720 },
  styles: {
    variables: Object.fromEntries(
      MESSAGE_ARTIFACT_STYLE_VARIABLES.map((name) => [name, "system-ui"]),
    ) as Record<MessageArtifactStyleVariable, string>,
  },
};

describe("MCP Apps host", () => {
  const makeHost = (key: string, openLink: (url: string) => boolean | Promise<boolean>) => {
    const sent: object[] = [];
    const onHeight = vi.fn();
    const onUnload = vi.fn();
    const host = createMessageArtifactHost({
      key,
      context,
      send: (message) => sent.push(message),
      onHeight,
      openLink,
      onUnload,
    });
    return { host, sent, onHeight, onUnload };
  };
  const openLinkRequest = (id: string, url = "https://t3.codes") => ({
    jsonrpc: "2.0",
    id,
    method: "ui/open-link",
    params: { url },
  });

  it("answers the handshake and ping, and sends context changes only after the handshake", () => {
    const { host, sent } = makeHost("artifact:handshake", () => true);
    const light = { ...context, theme: "light" as const };

    host.updateContext(light);
    host.receive({ jsonrpc: "2.0", id: "t3:1", method: "ui/initialize", params: {} });
    host.receive(JSON.stringify({ jsonrpc: "2.0", method: "ui/notifications/initialized" }));
    host.receive({ jsonrpc: "2.0", id: 0, method: "ping" });
    host.updateContext(context);

    expect(sent).toEqual([
      {
        jsonrpc: "2.0",
        id: "t3:1",
        result: expect.objectContaining({ protocolVersion: "2026-01-26", hostContext: light }),
      },
      { jsonrpc: "2.0", id: 0, result: {} },
      { jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: context },
    ]);
  });

  it("clamps sizes, ignores jitter, stops on unload, and rejects unknown requests", () => {
    const { host, sent, onHeight, onUnload } = makeHost("artifact:requests", () => true);
    const size = (height: number) =>
      host.receive({
        jsonrpc: "2.0",
        method: "ui/notifications/size-changed",
        params: { width: 400, height },
      });

    size(20);
    size(321);
    size(322);
    size(2_000);
    host.receive({ jsonrpc: "2.0", method: "t3/notifications/unloading", params: {} });
    host.receive({ jsonrpc: "2.0", id: 4, method: "tools/call", params: {} });
    host.receive({ type: "not-json-rpc", height: 999 });

    expect(onHeight.mock.calls).toEqual([[96], [321], [720]]);
    expect(onUnload).toHaveBeenCalledOnce();
    expect(sent).toEqual([
      { jsonrpc: "2.0", id: 4, error: expect.objectContaining({ code: -32601 }) },
    ]);
  });

  it("opens web links only when allowed, and at most once per second", () => {
    vi.useFakeTimers();
    let allowed = false;
    const openLink = vi.fn(() => allowed);
    const { host, sent } = makeHost("artifact:links", openLink);

    host.receive(openLinkRequest("t3:1"));
    vi.advanceTimersByTime(1_000);
    allowed = true;
    host.receive(openLinkRequest("t3:2", "javascript:alert(1)"));
    host.receive(openLinkRequest("t3:3"));
    host.receive(openLinkRequest("t3:4"));
    vi.advanceTimersByTime(1_000);
    host.receive(openLinkRequest("t3:5"));

    expect(openLink.mock.calls).toEqual([
      ["https://t3.codes/"],
      ["https://t3.codes/"],
      ["https://t3.codes/"],
    ]);
    expect(sent).toEqual([
      { jsonrpc: "2.0", id: "t3:1", error: expect.objectContaining({ code: -32000 }) },
      { jsonrpc: "2.0", id: "t3:2", error: expect.objectContaining({ code: -32000 }) },
      { jsonrpc: "2.0", id: "t3:3", result: {} },
      { jsonrpc: "2.0", id: "t3:4", error: expect.objectContaining({ code: -32000 }) },
      { jsonrpc: "2.0", id: "t3:5", result: {} },
    ]);
  });

  it("refuses further links while a confirmation is pending, then answers with the choice", async () => {
    vi.useFakeTimers();
    let confirm: (opened: boolean) => void = () => undefined;
    const { host, sent } = makeHost(
      "artifact:confirm",
      () => new Promise<boolean>((resolve) => (confirm = resolve)),
    );

    host.receive(openLinkRequest("t3:1"));
    vi.advanceTimersByTime(5_000);
    host.receive(openLinkRequest("t3:2"));
    confirm(false);
    await Promise.resolve();

    expect(sent).toEqual([
      { jsonrpc: "2.0", id: "t3:2", error: expect.objectContaining({ code: -32000 }) },
      { jsonrpc: "2.0", id: "t3:1", error: expect.objectContaining({ code: -32000 }) },
    ]);
  });

  it("remembers bounded state and hiding, and a rebuilt document starts from the latest state", () => {
    const { host } = makeHost("artifact:state", () => true);
    const stateChanged = (name: string) =>
      host.receive({
        jsonrpc: "2.0",
        method: "t3/notifications/state-changed",
        params: { fields: { name, oversized: "x".repeat(5_000) }, data: '{"step":2}' },
      });
    const rebuild = () =>
      createSandboxedMessageArtifactDocument("<input name=name>", {
        state: readMessageArtifactMemory("artifact:state")?.state,
      });

    stateChanged("Ada");
    rememberMessageArtifact("artifact:state", { height: 480, hidden: true });
    const first = rebuild();
    stateChanged("Grace");

    expect(readMessageArtifactMemory("artifact:state")).toEqual({
      state: { fields: { name: "Grace" }, data: '{"step":2}' },
      height: 480,
      hidden: true,
    });
    expect(first).toContain('"fields":{"name":"Ada"}');
    expect(rebuild()).toContain('"fields":{"name":"Grace"}');
  });
});

describe("message artifact document", () => {
  it("applies the network policy before any authored script runs", () => {
    const authored = "<script>window.ready = true</script><p>Bonjour</p>";
    const document = createSandboxedMessageArtifactDocument(authored);

    expect(document.indexOf("connect-src 'none'")).toBeLessThan(document.indexOf("window.ready"));
    expect(document.endsWith(authored)).toBe(true);
  });

  it("keeps host values from terminating the script element that carries them", () => {
    const document = createSandboxedMessageArtifactDocument("", {
      context: {
        ...context,
        styles: {
          variables: {
            ...context.styles.variables,
            "--font-sans": "</script><script>window.injected=true</script>",
          },
        },
      },
      state: { fields: { note: "</script><script>window.injected=true</script>" } },
    });

    expect(document).not.toContain("</script><script>window.injected");
  });
});

function inertResponse(body: BodyInit, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    ...init,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

describe("fetchMessageArtifactHtml", () => {
  it("decodes split UTF-8 chunks without sending credentials", async () => {
    const bytes = new TextEncoder().encode("<p>système</p>");
    const splitAt = bytes.indexOf(0xc3) + 1;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, splitAt));
        controller.enqueue(bytes.slice(splitAt));
        controller.close();
      },
    });
    const fetchImpl = vi.fn(async () => inertResponse(body));

    await expect(
      fetchMessageArtifactHtml(
        "https://assets.test/artifact",
        new AbortController().signal,
        fetchImpl as unknown as typeof fetch,
      ),
    ).resolves.toBe("<p>système</p>");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://assets.test/artifact",
      expect.objectContaining({ credentials: "omit" }),
    );
  });

  it("reports HTTP failures, executable content types and network errors as one known message", async () => {
    const signal = new AbortController().signal;
    const withoutStream = (response: Response) =>
      ({
        ok: response.ok,
        headers: response.headers,
        body: null,
        text: () => response.text(),
      }) as unknown as Response;
    const load = (fetchImpl: () => Promise<Response>) =>
      fetchMessageArtifactHtml(
        "https://assets.test/artifact",
        signal,
        fetchImpl as unknown as typeof fetch,
      );

    for (const wrap of [(response: Response) => response, withoutStream]) {
      await expect(
        load(async () => wrap(inertResponse("Not Found", { status: 404 }))),
      ).rejects.toThrow("The artifact could not be loaded.");
      await expect(
        load(async () =>
          wrap(new Response("<script></script>", { headers: { "content-type": "text/html" } })),
        ),
      ).rejects.toThrow("The artifact could not be loaded.");
    }
    await expect(
      load(async () => {
        throw new TypeError("Failed to fetch");
      }),
    ).rejects.toThrow("The artifact could not be loaded.");
    await expect(load(async () => withoutStream(inertResponse("<p>ok</p>")))).resolves.toBe(
      "<p>ok</p>",
    );
  });

  it("gives up on a stalled response", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );

    const loaded = expect(
      fetchMessageArtifactHtml(
        "https://assets.test/stalled.html",
        new AbortController().signal,
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow("took too long");
    await vi.advanceTimersByTimeAsync(15_000);
    await loaded;
  });
});
