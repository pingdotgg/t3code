import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";

import { clearCuaToolContext } from "./cuaToolPresentation.ts";
import { cuaCallContext, mcpToolPresentation } from "./mcpToolPresentation.ts";

describe("mcpToolPresentation", () => {
  it.each([
    "javascript:alert(1)",
    "file:///tmp/logo.png",
    "not a URL",
    "https://example.com/" + "x".repeat(4096),
  ])("ignores an invalid logo %s", (iconUrl) => {
    expect(
      mcpToolPresentation({
        serverName: "weather",
        toolName: "get_weather",
        iconUrl,
        title: "x".repeat(161),
      }),
    ).toEqual({
      title: "get weather",
      toolSource: { key: "mcp:weather", name: "weather", kind: "integration" },
    });
  });

  it("presents Cua Driver calls from any provider as computer use in the app they drive", () => {
    const threadId = ThreadId.make("thread-mcp-cua");
    clearCuaToolContext(threadId);
    // An earlier list_apps result teaches the thread which app owns pid 512.
    cuaCallContext({
      serverName: "cua-driver",
      toolName: "list_apps",
      threadId,
      status: "completed",
      args: {},
      result: { apps: [{ pid: 512, name: "Safari", bundle_id: "com.apple.Safari" }] },
    });
    for (const [serverName, toolName] of [
      ["cua-driver", "click"],
      ["cua_driver", "click"],
      [undefined, "mcp__cua-driver__click"],
    ] as const) {
      const presentation = mcpToolPresentation({
        serverName,
        toolName,
        ...cuaCallContext({
          serverName: serverName ?? "cua-driver",
          toolName: "click",
          threadId,
          status: "running",
          args: { pid: 512, window_id: 3 },
        }),
      });
      expect(presentation).toMatchObject({
        title: "Clicking in Safari",
        toolSurface: "computer",
        toolSource: { key: "native-app:com.apple.safari", kind: "computer" },
      });
    }
  });
});
