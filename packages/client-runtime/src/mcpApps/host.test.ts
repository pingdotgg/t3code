import { describe, expect, it, vi } from "vite-plus/test";

import { MAX_TOOL_OUTPUT_IMAGES } from "@t3tools/shared/toolOutput";

import {
  hydrateMcpAppToolResultImages,
  makeMcpAppHost,
  McpAppHostRefusal,
  type McpAppHostContext,
} from "./host.ts";

const app = {
  attachmentId: "thread-1-app",
  server: "weather",
  tool: "get_weather",
  resourceUri: "ui://weather/dashboard",
  csp: { connectDomains: ["https://api.weather.test"] },
};

const context = (
  theme: "light" | "dark" = "dark",
  displayMode: "inline" | "fullscreen" = "inline",
): McpAppHostContext => ({
  theme,
  styles: { variables: { "--color-background-primary": theme === "dark" ? "#000" : "#fff" } },
  displayMode,
  availableDisplayModes: ["inline", "fullscreen"],
  containerDimensions: { width: 600, maxHeight: 2000 },
  platform: "web",
});

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve)).then(() => undefined);

const initialize = (
  host: ReturnType<typeof makeMcpAppHost>,
  appCapabilities: Record<string, unknown> = {},
) => {
  host.receive({
    jsonrpc: "2.0",
    id: "init",
    method: "ui/initialize",
    params: { appCapabilities },
  });
  host.receive({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
};

function setup(overrides: Partial<Parameters<typeof makeMcpAppHost>[0]> = {}) {
  const sent: Array<Record<string, unknown>> = [];
  let theme: "light" | "dark" = "dark";
  let mode: "inline" | "fullscreen" = "inline";
  const host = makeMcpAppHost({
    app,
    hostVersion: "1.0.0",
    post: (message) => sent.push(message as Record<string, unknown>),
    hostContext: () => context(theme, mode),
    callTool: async (input) => ({ content: [{ type: "text", text: `called ${input.name}` }] }),
    readResource: async () => ({ contents: [] }),
    openLink: async () => undefined,
    sendMessage: async () => undefined,
    updateModelContext: async () => undefined,
    requestDisplayMode: async (next) => {
      mode = next === "fullscreen" ? "fullscreen" : "inline";
      return mode;
    },
    downloadFile: async () => undefined,
    onRequestTeardown: () => undefined,
    onSizeChanged: () => undefined,
    loadToolOutputImage: async () => undefined,
    ...overrides,
  });
  return {
    host,
    sent,
    setTheme: (next: "light" | "dark") => {
      theme = next;
    },
  };
}

describe("makeMcpAppHost", () => {
  it("initializes, then replays the tool input and result after initialized", () => {
    const { host, sent } = setup();
    host.setToolCall({
      arguments: { city: "Oslo" },
      result: { content: [{ type: "text", text: "Sunny" }] },
    });
    host.receive({
      jsonrpc: "2.0",
      id: 1,
      method: "ui/initialize",
      params: { protocolVersion: "2026-01-26", appInfo: { name: "a", version: "1" } },
    });
    expect(sent[0]).toMatchObject({
      id: 1,
      result: {
        protocolVersion: "2026-01-26",
        hostCapabilities: { serverTools: {}, sandbox: { csp: app.csp } },
        hostContext: { theme: "dark", displayMode: "inline" },
      },
    });
    expect(sent).toHaveLength(1);

    host.receive({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
    expect(sent.slice(1)).toEqual([
      {
        jsonrpc: "2.0",
        method: "ui/notifications/tool-input",
        params: { arguments: { city: "Oslo" } },
      },
      {
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: { content: [{ type: "text", text: "Sunny" }] },
      },
    ]);
  });

  it("drops null fields providers report, which the MCP Apps SDK rejects", async () => {
    const { host, sent } = setup({
      callTool: async () => ({ content: [], structuredContent: null, _meta: null }),
    });
    host.receive({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: {} });
    host.receive({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
    host.setToolCall({
      arguments: {},
      result: {
        content: [{ type: "text", text: "t" }],
        structuredContent: { time: "t" },
        _meta: null,
      },
    });
    host.receive({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get-time" } });
    await flush();
    expect(sent.find((m) => m.method === "ui/notifications/tool-result")?.params).toEqual({
      content: [{ type: "text", text: "t" }],
      structuredContent: { time: "t" },
    });
    expect(sent.find((m) => m.id === 2)?.result).toEqual({ content: [] });
  });

  it("sends a later result for a call that had none, without repeating its input", () => {
    const { host, sent } = setup();
    initialize(host);
    sent.length = 0;
    host.setToolCall({ arguments: { city: "Oslo" }, result: undefined });
    host.setToolCall({
      arguments: { city: "Oslo" },
      result: { content: [{ type: "text", text: "Sunny" }] },
    });
    host.setToolCall({
      arguments: { city: "Bergen" },
      result: { content: [{ type: "text", text: "Rain" }] },
    });
    expect(sent).toEqual([
      {
        jsonrpc: "2.0",
        method: "ui/notifications/tool-input",
        params: { arguments: { city: "Oslo" } },
      },
      {
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: { content: [{ type: "text", text: "Sunny" }] },
      },
    ]);
  });

  it("sends a stored screenshot with the bytes its detail omitted, once", async () => {
    const delivered = Promise.withResolvers<unknown>();
    const sent: Array<Record<string, unknown>> = [];
    const { host } = setup({
      post: (message) => {
        const record = message as Record<string, unknown>;
        sent.push(record);
        if (record.method === "ui/notifications/tool-result") delivered.resolve(record.params);
      },
      loadToolOutputImage: async (index) => (index === 0 ? new Uint8Array([1, 2, 3]) : undefined),
    });
    const call = {
      arguments: {},
      result: {
        content: [{ type: "image", mimeType: "image/png", annotations: { priority: 1 } }],
        structuredContent: { device: "phone" },
      },
    };
    host.setToolCall(call);
    initialize(host);
    host.setToolCall(call);
    expect(await delivered.promise).toEqual({
      content: [
        { type: "image", data: "AQID", mimeType: "image/png", annotations: { priority: 1 } },
      ],
      structuredContent: { device: "phone" },
    });
    expect(
      sent
        .filter(
          (m) => typeof m.method === "string" && m.method.startsWith("ui/notifications/tool-"),
        )
        .map((m) => m.method),
    ).toEqual(["ui/notifications/tool-input", "ui/notifications/tool-result"]);
  });

  it("answers the app's tool call, not its other requests, after the stored screenshot", async () => {
    const image = Promise.withResolvers<Uint8Array>();
    const called = Promise.withResolvers<void>();
    const answered = Promise.withResolvers<void>();
    const read = Promise.withResolvers<void>();
    const sent: Array<Record<string, unknown>> = [];
    const { host } = setup({
      post: (message) => {
        const record = message as Record<string, unknown>;
        sent.push(record);
        if (record.id === 9) answered.resolve();
        if (record.id === 10) read.resolve();
      },
      callTool: async () => {
        called.resolve();
        return { content: [{ type: "text", text: "newer" }] };
      },
      loadToolOutputImage: () => image.promise,
    });
    host.setToolCall({
      arguments: {},
      result: { content: [{ type: "image", mimeType: "image/png" }] },
    });
    initialize(host);
    host.receive({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "refresh" } });
    host.receive({ jsonrpc: "2.0", id: 10, method: "resources/read", params: { uri: "ui://x" } });
    await called.promise;
    await read.promise;
    expect(sent.some((m) => m.id === 9)).toBe(false);
    image.resolve(new Uint8Array([1, 2, 3]));
    await answered.promise;
    const order = sent
      .filter((m) => m.id === 9 || m.method === "ui/notifications/tool-result")
      .map((m) => m.id ?? m.method);
    expect(order).toEqual(["ui/notifications/tool-result", 9]);
  });

  it("sends the screenshot marker and answers the app when an image load stalls", async () => {
    const answered = Promise.withResolvers<void>();
    const sent: Array<Record<string, unknown>> = [];
    const { host } = setup({
      post: (message) => {
        const record = message as Record<string, unknown>;
        sent.push(record);
        if (record.id === 9) answered.resolve();
      },
      loadToolOutputImage: () => new Promise(() => undefined),
    });
    vi.useFakeTimers();
    try {
      host.setToolCall({
        arguments: {},
        result: { content: [{ type: "image", mimeType: "image/png" }] },
      });
      initialize(host);
      host.receive({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "refresh" } });
      await vi.advanceTimersByTimeAsync(15_000);
      await answered.promise;
    } finally {
      vi.useRealTimers();
    }
    expect(sent.find((m) => m.method === "ui/notifications/tool-result")?.params).toEqual({
      content: [{ type: "image", mimeType: "image/png" }],
    });
  });

  it("accepts ui/message as one text block or the SDK's block array", async () => {
    const messages: Array<string> = [];
    const { host, sent } = setup({ sendMessage: async (text) => void messages.push(text) });
    host.receive({
      jsonrpc: "2.0",
      id: 1,
      method: "ui/message",
      params: { role: "user", content: { type: "text", text: "one" } },
    });
    host.receive({
      jsonrpc: "2.0",
      id: 2,
      method: "ui/message",
      params: { role: "user", content: [{ type: "text", text: "two" }] },
    });
    host.receive({
      jsonrpc: "2.0",
      id: 3,
      method: "ui/message",
      params: { role: "user", content: [{ type: "image", data: "x" }] },
    });
    host.receive({
      jsonrpc: "2.0",
      id: 4,
      method: "ui/message",
      params: { role: "user", content: { type: "text", text: "   " } },
    });
    await flush();
    expect(messages).toEqual(["one", "two"]);
    expect(sent.find((m) => m.id === 3)?.error).toMatchObject({ code: -32602 });
    expect(sent.find((m) => m.id === 4)?.error).toMatchObject({ code: -32602 });
  });

  it("catches the app up on context that changed while it was initializing", () => {
    const { host, sent, setTheme } = setup();
    host.receive({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: {} });
    setTheme("light");
    host.receive({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
    expect(sent.at(-1)).toEqual({
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params: { theme: "light", styles: context("light").styles },
    });
  });

  it("proxies tools/call and reports a refusal as a JSON-RPC error", async () => {
    const received: unknown[] = [];
    const { host, sent } = setup({
      callTool: async (input) => {
        if (input.name === "delete_everything")
          throw new McpAppHostRefusal({ message: "Declined by the user." });
        received.push(input.arguments);
        return { content: [], structuredContent: { ok: true } };
      },
    });
    host.receive({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "refresh" } });
    host.receive({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "delete_everything", arguments: {} },
    });
    // postMessage's structured clone keeps undefined properties, which JSON cannot carry.
    host.receive({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: {
        name: "poll",
        arguments: { since: undefined, nested: { a: undefined, b: 1 }, list: [1, undefined] },
      },
    });
    await flush();
    expect(received).toStrictEqual([{}, { nested: { b: 1 }, list: [1, null] }]);
    expect(sent).toContainEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { content: [], structuredContent: { ok: true } },
    });
    expect(sent).toContainEqual({
      jsonrpc: "2.0",
      id: 8,
      error: { code: -32000, message: "Declined by the user." },
    });
  });

  it("rejects malformed requests and unsupported methods", () => {
    const { host, sent } = setup();
    host.receive({
      jsonrpc: "2.0",
      id: 1,
      method: "ui/open-link",
      params: { url: "javascript:x" },
    });
    host.receive({ jsonrpc: "2.0", id: 3, method: "sampling/createMessage", params: {} });
    host.receive({ jsonrpc: "2.0", id: 4, method: "ui/message", params: { role: "assistant" } });
    host.receive({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "poll", arguments: { since: 1n } },
    });
    expect(sent.map((message) => (message.error as { code: number }).code)).toEqual([
      -32602, -32601, -32602, -32602,
    ]);
  });

  it("refuses requests past the in-flight limit and posts nothing after dispose", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { host, sent } = setup({
      callTool: async () => {
        await gate;
        return { content: [] };
      },
    });
    for (let id = 0; id < 17; id++) {
      host.receive({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "slow" } });
    }
    expect(sent).toEqual([
      { jsonrpc: "2.0", id: 16, error: { code: -32000, message: "Too many requests in flight." } },
    ]);
    host.dispose();
    release();
    await flush();
    expect(sent).toHaveLength(1);
  });

  it("switches display mode only to one both sides offer, and tells the app", async () => {
    const { host, sent } = setup();
    initialize(host, { availableDisplayModes: ["inline", "fullscreen"] });
    sent.length = 0;
    host.receive({
      jsonrpc: "2.0",
      id: 1,
      method: "ui/request-display-mode",
      params: { mode: "pip" },
    });
    host.receive({
      jsonrpc: "2.0",
      id: 2,
      method: "ui/request-display-mode",
      params: { mode: "fullscreen" },
    });
    await flush();
    host.updateHostContext();
    expect(sent.find((m) => m.id === 1)?.result).toEqual({ mode: "inline" });
    expect(sent.find((m) => m.id === 2)?.result).toEqual({ mode: "fullscreen" });
    expect(sent.find((m) => m.method === "ui/notifications/host-context-changed")?.params).toEqual({
      displayMode: "fullscreen",
    });

    const declined = setup();
    initialize(declined.host, { availableDisplayModes: ["inline"] });
    declined.host.receive({
      jsonrpc: "2.0",
      id: 3,
      method: "ui/request-display-mode",
      params: { mode: "fullscreen" },
    });
    await flush();
    expect(declined.sent.find((m) => m.id === 3)?.result).toEqual({ mode: "inline" });
  });

  it("forwards model context and download requests, and declares both", async () => {
    const contexts: Array<unknown> = [];
    const downloads: Array<ReadonlyArray<{ readonly name: string }>> = [];
    const { host, sent } = setup({
      updateModelContext: async (update) => void contexts.push(update),
      downloadFile: async (files) => {
        downloads.push(files);
        if (files.length > 1) throw new McpAppHostRefusal({ message: "Declined by the user." });
      },
    });
    initialize(host);
    const capabilities = (
      sent[0]?.result as { hostCapabilities: Record<string, unknown> } | undefined
    )?.hostCapabilities;
    expect(capabilities?.updateModelContext).toEqual({ text: {}, structuredContent: {} });
    expect(capabilities?.downloadFile).toEqual({});

    host.receive({
      jsonrpc: "2.0",
      id: 1,
      method: "ui/update-model-context",
      params: {
        content: [{ type: "text", text: "2 overdue" }],
        structuredContent: { overdue: 2, since: undefined },
      },
    });
    const longName = `${"a".repeat(199)}😀.csv`;
    const embedded = {
      type: "resource",
      resource: { uri: "file:///report.csv", mimeType: "text/csv", text: "a,b" },
    };
    host.receive({
      jsonrpc: "2.0",
      id: 2,
      method: "ui/download-file",
      params: { contents: [embedded] },
    });
    host.receive({
      jsonrpc: "2.0",
      id: 3,
      method: "ui/download-file",
      params: {
        contents: [embedded, { type: "resource_link", uri: "ui://todos/export", name: longName }],
      },
    });
    host.receive({ jsonrpc: "2.0", id: 4, method: "ui/download-file", params: { contents: [{}] } });
    await flush();
    expect(contexts).toStrictEqual([
      { content: [{ type: "text", text: "2 overdue" }], structuredContent: { overdue: 2 } },
    ]);
    expect(downloads[0]).toEqual([
      {
        _tag: "embedded",
        name: "report.csv",
        mimeType: "text/csv",
        bytes: new TextEncoder().encode("a,b"),
      },
    ]);
    const capped = downloads[1]?.[1]?.name ?? "";
    expect(capped.length).toBeLessThanOrEqual(200);
    expect(capped.isWellFormed()).toBe(true);
    expect(sent.find((m) => m.id === 2)?.result).toEqual({});
    expect(sent.find((m) => m.id === 3)?.result).toEqual({ isError: true });
    expect(sent.find((m) => m.id === 4)?.error).toMatchObject({ code: -32602 });
  });
});

describe("hydrateMcpAppToolResultImages", () => {
  it("loads only data-less raster markers, by tool-output-image index and within the cap", async () => {
    const requested: Array<number> = [];
    const png = { type: "image", mimeType: "image/png" };
    const hydrated = await hydrateMcpAppToolResultImages(
      {
        content: [
          { type: "text", text: "shot" },
          { type: "image", mimeType: "image/svg+xml" },
          { ...png, data: "AAAA" },
          png,
          { type: "image", mimeType: "image/jpeg" },
          ...Array.from({ length: MAX_TOOL_OUTPUT_IMAGES }, () => png),
        ],
      },
      async (index) => {
        requested.push(index);
        if (index === 2) throw new Error("gone");
        return index === 1 ? new Uint8Array([1, 2, 3]) : undefined;
      },
    );
    expect(requested).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(hydrated?.content.slice(0, 5)).toEqual([
      { type: "text", text: "shot" },
      { type: "image", mimeType: "image/svg+xml" },
      { ...png, data: "AAAA" },
      { type: "image", data: "AQID", mimeType: "image/png" },
      { type: "image", mimeType: "image/jpeg" },
    ]);
    expect(
      hydrateMcpAppToolResultImages({ content: [{ ...png, data: "AAAA" }] }, async () => {
        throw new Error("not called");
      }),
    ).toBeUndefined();
  });
});
