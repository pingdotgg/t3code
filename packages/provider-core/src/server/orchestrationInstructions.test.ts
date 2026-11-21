import { assert, describe, it } from "@effect/vitest";

import {
  LATHE_DEVICE_TOOL_INSTRUCTIONS,
  LATHE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH,
  LATHE_ORCHESTRATION_INSTRUCTIONS,
  latheAcpPromptWithInstructions,
  latheOrchestrationPrompt,
  latheOrchestrationSystemPrompt,
} from "./orchestrationInstructions.ts";

describe("Lathe device instructions", () => {
  it("route device work through device_open and give Claude the line that loads the tools", () => {
    for (const intent of ["`device_list`", "`device_open`", "`agent-device`", "ssh", "`hostId`"]) {
      assert.include(LATHE_DEVICE_TOOL_INSTRUCTIONS, intent);
    }
    assert.notInclude(LATHE_DEVICE_TOOL_INSTRUCTIONS, "ToolSearch");
    const loadLine =
      " Load them with ToolSearch `select:mcp__lathe__device_list,mcp__lathe__device_open,mcp__lathe__device_screenshot,mcp__lathe__device_close`.";
    assert.include(LATHE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH, loadLine);
    assert.equal(
      LATHE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH.replace(loadLine, ""),
      LATHE_DEVICE_TOOL_INSTRUCTIONS,
    );
  });

  it("open the app before the returned command's snapshots, screenshots and input", () => {
    assert.include(
      LATHE_DEVICE_TOOL_INSTRUCTIONS,
      "its snapshots, screenshots and input need `open <app>` first,",
    );
  });

  it("keep the failure rule from taking over or closing a session another thread holds", () => {
    // agent-device's DEVICE_IN_USE advice is to rerun with the owner's --session or close it first.
    assert.include(
      LATHE_DEVICE_TOOL_INSTRUCTIONS,
      "follow its advice once, but never reuse or close another session; if it still fails,",
    );
  });

  it("reach OpenCode and Cursor only when the session holds device access", () => {
    assert.include(latheOrchestrationSystemPrompt(true, true), LATHE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(latheOrchestrationSystemPrompt(true, false), "## Lathe devices");
    assert.isUndefined(latheOrchestrationSystemPrompt(false, true));

    const firstRun = (hasDeviceTools: boolean) =>
      latheOrchestrationPrompt({
        prompt: "Check the login screen.",
        hasLatheMcp: true,
        hasDeviceTools,
        orchestrationDelivered: false,
        deviceInstructionsDelivered: false,
      });
    assert.include(firstRun(true), LATHE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(firstRun(false), "## Lathe devices");

    const laterRun = (deviceInstructionsDelivered: boolean) =>
      latheOrchestrationPrompt({
        prompt: "Check the login screen.",
        hasLatheMcp: true,
        hasDeviceTools: true,
        orchestrationDelivered: true,
        deviceInstructionsDelivered,
      });
    assert.include(laterRun(false), LATHE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(laterRun(false), LATHE_ORCHESTRATION_INSTRUCTIONS.trim());
    assert.equal(laterRun(true), "Check the login screen.");

    // A provider's own guidance reaches a conversation that already had the rest.
    const providerRun = (providerInstructionsDelivered: boolean) =>
      latheOrchestrationPrompt({
        prompt: "Check the login screen.",
        hasLatheMcp: true,
        hasDeviceTools: false,
        orchestrationDelivered: true,
        deviceInstructionsDelivered: false,
        providerInstructions: "Mark awaited shells.",
        providerInstructionsDelivered,
      });
    assert.include(providerRun(false), "Mark awaited shells.");
    assert.notInclude(providerRun(false), LATHE_ORCHESTRATION_INSTRUCTIONS.trim());
    assert.equal(providerRun(true), "Check the login screen.");
  });

  it("reach ACP agents again when device access changes mid-thread", () => {
    const state = { interactionMode: "default", hasLatheMcp: true, hasDeviceTools: false } as const;
    const withDevices = latheAcpPromptWithInstructions({
      prompt: "Check the login screen.",
      state: { ...state, hasDeviceTools: true },
      previousState: state,
    });
    assert.include(withDevices, LATHE_DEVICE_TOOL_INSTRUCTIONS);
    assert.equal(
      latheAcpPromptWithInstructions({ prompt: "Again.", state, previousState: state }),
      "Again.",
    );
    assert.notInclude(latheAcpPromptWithInstructions({ prompt: "Hi.", state }), "## Lathe devices");
  });
});
