import type { OrchestrationV2TurnItem, RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isRunUsingComputer, selectLatestComputerUse } from "./computerUsePreview";

const tool = (
  id: string,
  status: OrchestrationV2TurnItem["status"],
  extra: Partial<Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }>> = {},
) =>
  ({
    id,
    type: "dynamic_tool",
    status,
    toolName: "mcp__cua-driver__click",
    input: {},
    ...extra,
  }) as unknown as OrchestrationV2TurnItem;

describe("selectLatestComputerUse", () => {
  it("picks the newest computer use call with its app, whatever the provider", () => {
    const safari = {
      _tag: "native-app",
      app: { _tag: "app-id", appId: "com.apple.Safari" },
    } as const;
    expect(
      selectLatestComputerUse([
        tool("older", "completed", { toolSurface: "computer" }),
        tool("newest", "running", {
          toolSurface: "computer",
          toolIcon: safari,
          toolSource: { key: "native-app:com.apple.safari", name: "Safari", kind: "computer" },
        }),
        tool("unrelated", "running"),
      ]),
    ).toEqual({
      itemId: "newest",
      app: safari.app,
      appName: "Safari",
      inProgress: true,
    });
  });

  it("finds nothing in a thread without computer use", () => {
    expect(selectLatestComputerUse([tool("plain", "completed")])).toBeNull();
  });
});

describe("isRunUsingComputer", () => {
  const run = "run-1" as RunId;
  it("is true only once the running run has made a computer use call", () => {
    const earlier = tool("earlier", "completed", {
      runId: "run-0" as RunId,
      toolSurface: "computer",
    });
    const plain = tool("plain", "completed", { runId: run });
    expect(isRunUsingComputer([earlier, plain], run)).toBe(false);
    expect(
      isRunUsingComputer(
        [earlier, plain, tool("click", "completed", { runId: run, toolSurface: "computer" })],
        run,
      ),
    ).toBe(true);
    expect(isRunUsingComputer([earlier], null)).toBe(false);
  });
});
