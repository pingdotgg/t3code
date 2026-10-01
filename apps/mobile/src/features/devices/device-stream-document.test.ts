import * as NodeVM from "node:vm";
import { describe, expect, it, vi } from "vite-plus/test";

import { deviceStreamDocument, deviceStreamMessage } from "./device-stream-document";

describe("native device stream document", () => {
  it("keeps ticket and device values from terminating the embedded script", () => {
    const deviceId = '</script><script>alert("device")</script>';
    const configuration = JSON.stringify({ deviceId, ticket: "<ticket>" });
    const html = deviceStreamDocument(
      configuration,
      "var T3DeviceStream={start(input){return input}};",
    );
    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
    expect(html.match(/<script>/g)).toHaveLength(1);
    const input: unknown = NodeVM.runInNewContext(script!, { window: { addEventListener() {} } });
    expect(input).toEqual({ deviceId, ticket: "<ticket>" });
  });

  it("preserves script strings containing an HTML closing delimiter", () => {
    const html = deviceStreamDocument("{}", 'var text="</script>";');
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html).toContain('var text="<\\/script>";');
  });

  it("reports a bootstrap exception to the native recovery UI", () => {
    const postMessage = vi.fn();
    const html = deviceStreamDocument(
      "{}",
      'var T3DeviceStream={start(){throw new Error("startup")}};',
    );
    NodeVM.runInNewContext(html.match(/<script>([\s\S]*)<\/script>/)![1]!, {
      window: { addEventListener() {}, ReactNativeWebView: { postMessage } },
    });
    expect(JSON.parse(postMessage.mock.calls[0]![0] as string)).toEqual({
      type: "status",
      status: "error",
      detail: "Device viewer stopped unexpectedly.",
    });
  });

  it.each(["error", "unhandledrejection"])("reports later %s failures to native", (event) => {
    const postMessage = vi.fn();
    const listeners = new Map<string, () => void>();
    const html = deviceStreamDocument("{}", "var T3DeviceStream={start(){}};");
    NodeVM.runInNewContext(html.match(/<script>([\s\S]*)<\/script>/)![1]!, {
      window: {
        addEventListener: (name: string, callback: () => void) => listeners.set(name, callback),
        ReactNativeWebView: { postMessage },
      },
    });
    listeners.get(event)!();
    expect(JSON.parse(postMessage.mock.calls[0]![0] as string)).toMatchObject({
      type: "status",
      status: "error",
    });
  });
});

describe("native device stream messages", () => {
  it("accepts authentication renewal and input connection changes", () => {
    expect(deviceStreamMessage('{"type":"unauthorized"}')).toEqual({ type: "unauthorized" });
    expect(deviceStreamMessage('{"type":"input","connected":true}')).toEqual({
      type: "input",
      connected: true,
    });
    expect(deviceStreamMessage('{"type":"input","connected":false}')).toEqual({
      type: "input",
      connected: false,
    });
    expect(deviceStreamMessage('{"type":"retry"}')).toEqual({ type: "retry" });
  });

  it.each(["connecting", "streaming", "error"])("accepts stream %s feedback", (status) => {
    expect(
      deviceStreamMessage(JSON.stringify({ type: "status", status, detail: "Stream feedback" })),
    ).toEqual({ type: "status", status, detail: "Stream feedback" });
  });

  it.each([
    "invalid JSON",
    "null",
    '"input"',
    "{}",
    '{"type":"input","connected":"yes"}',
    '{"type":"unknown"}',
    '{"type":"status","status":"unknown"}',
    '{"type":"status","status":"error","detail":42}',
    '{"type":"status"}',
  ])("ignores invalid bridge messages: %s", (data) => expect(deviceStreamMessage(data)).toBeNull());
});
