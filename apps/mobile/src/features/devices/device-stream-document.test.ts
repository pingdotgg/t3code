import * as NodeVM from "node:vm";
import { describe, expect, it } from "vite-plus/test";

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
    const input: unknown = NodeVM.runInNewContext(script!);
    expect(input).toEqual({ deviceId, ticket: "<ticket>" });
  });

  it("preserves script strings containing an HTML closing delimiter", () => {
    const html = deviceStreamDocument("{}", 'var text="</script>";');
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html).toContain('var text="<\\/script>";');
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

  it.each([
    "invalid JSON",
    "null",
    '"input"',
    "{}",
    '{"type":"input","connected":"yes"}',
    '{"type":"unknown"}',
  ])("ignores invalid bridge messages: %s", (data) => expect(deviceStreamMessage(data)).toBeNull());
});
