import { expect, mock, test } from "bun:test";
mock.module("message_keys", () => ({ bytes: 4 }));
mock.module("../src/pkjs/config.json", () => ({ url: "https://test", token: "test" }));

test("speaks a new completed response only while its thread is focused", async () => {
  const handlers: Record<string, (event: any) => void> = {};
  const output: any[] = [];
  let poll: (() => void) | undefined;
  let item = { itemId: "old", type: "assistant_message", status: "completed", text: "old answer" };
  let speechCount = 0;
  const originalInterval = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  globalThis.setInterval = ((callback: () => void) => { poll = callback; return 1; }) as typeof setInterval;
  globalThis.clearInterval = (() => { poll = undefined; }) as typeof clearInterval;
  (globalThis as any).localStorage = { getItem: (key: string) => key === "url" ? "https://test" : "test", setItem: () => {} };
  (globalThis as any).Pebble = {
    addEventListener: (name: string, callback: (event: any) => void) => { handlers[name] = callback; },
    sendAppMessage: (message: any, success: () => void) => { output.push(message); success(); },
  };
  (globalThis as any).XMLHttpRequest = class {
    status = 200; responseText = ""; response: unknown; onload = () => {}; onerror = () => {}; path = "";
    open(_method: string, url: string) { this.path = new URL(url).pathname; }
    setRequestHeader() {}
    send() {
      if (this.path === "/threads") this.responseText = JSON.stringify({ threads: [{ threadId: "1", title: "one", machine: "Mac", directory: "/code/demo", providerInstanceId: "codex", updatedAt: new Date(Date.now() - 14 * 3600000).toISOString() }] });
      else if (this.path === "/read") this.responseText = JSON.stringify({ items: [item] });
      else if (this.path === "/speech") { speechCount++; this.response = new Uint8Array([1, 2]).buffer; }
      else this.responseText = "{}";
      this.onload();
    }
  };
  try {
    await import("../src/pkjs/index.js");
    handlers.ready!({});
    expect(output.find((message) => message.action === "thread")).toMatchObject({ machine: "Mac", directory: "demo", harness: "codex", age: "14h" });
    handlers.appmessage!({ payload: { action: "read", thread: "1" } });
    expect(speechCount).toBe(0);
    expect(output.some((message) => message.action === "chat_item" && message.title === "assistant_message")).toBe(true);
    item = { itemId: "new", type: "assistant_message", status: "running", text: "partial" };
    poll!(); expect(speechCount).toBe(0);
    item = { ...item, status: "completed", text: "finished" };
    poll!(); poll!(); expect(speechCount).toBe(1);
    const start = output.find((message) => message.action === "audio_start");
    const packet = output.find((message) => message.action === "audio");
    expect(start.size).toBe(1);
    expect(packet[4]).toHaveLength(1);
    expect(start.checksum).toBe(Math.imul(2166136261 ^ packet[4][0], 16777619) >>> 0);
    handlers.appmessage!({ payload: { action: "audio_ack" } });
    expect(output.at(-1).action).toBe("audio_play");
    handlers.appmessage!({ payload: { action: "audio_retry" } });
    expect(output.filter((message) => message.action === "audio_start")).toHaveLength(2);
    handlers.appmessage!({ payload: { action: "close" } });
    expect(poll).toBeUndefined();
  } finally { globalThis.setInterval = originalInterval; globalThis.clearInterval = originalClear; }
});
