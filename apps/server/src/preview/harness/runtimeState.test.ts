import { describe, expect, it } from "vitest";

import {
  applyPreviewRuntimeCommand,
  buildPreviewRuntimeArgNameSet,
  createPreviewRuntimeState,
} from "./runtimeState";
import type { PreviewScenarioDefinition } from "./types";

const scenarios: PreviewScenarioDefinition[] = [
  {
    id: "default",
    name: "Default",
    args: {
      displayText: "Copy",
      showText: true,
    },
  },
  {
    id: "icon-only",
    name: "Icon Only",
    args: {
      showText: false,
      ariaLabel: "Copy token address",
    },
  },
];

const validArgNames = buildPreviewRuntimeArgNameSet({
  controls: [
    {
      name: "displayText",
    },
    {
      name: "showText",
    },
    {
      name: "ariaLabel",
    },
  ],
  scenarios,
});

describe("preview runtime state", () => {
  it("ignores commands for a different runtime instance", () => {
    const state = createPreviewRuntimeState({
      runtimeInstanceId: "runtime-1",
      scenarios,
    });

    expect(
      applyPreviewRuntimeCommand({
        state,
        command: {
          kind: "preview.command.selectScenario",
          runtimeInstanceId: "runtime-2",
          commandId: 1,
          scenarioId: "icon-only",
        },
        scenarios,
        validArgNames,
      }),
    ).toEqual(state);
  });

  it("ignores stale command ids", () => {
    const state = {
      ...createPreviewRuntimeState({
        runtimeInstanceId: "runtime-1",
        scenarios,
      }),
      lastAppliedCommandId: 3,
    };

    expect(
      applyPreviewRuntimeCommand({
        state,
        command: {
          kind: "preview.command.setArgsPartial",
          runtimeInstanceId: "runtime-1",
          commandId: 2,
          argsPartial: { displayText: "Later" },
        },
        scenarios,
        validArgNames,
      }),
    ).toEqual(state);
  });

  it("restoreSession applies only valid keys", () => {
    const nextState = applyPreviewRuntimeCommand({
      state: createPreviewRuntimeState({
        runtimeInstanceId: "runtime-1",
        scenarios,
      }),
      command: {
        kind: "preview.command.restoreSession",
        runtimeInstanceId: "runtime-1",
        commandId: 1,
        selectedScenarioId: "icon-only",
        argOverrides: {
          displayText: "Copy contract address",
          invalidKey: "ignored",
        },
      },
      scenarios,
      validArgNames,
    });

    expect(nextState.selectedScenarioId).toBe("icon-only");
    expect(nextState.argOverrides).toEqual({
      displayText: "Copy contract address",
    });
    expect(nextState.lastAppliedCommandId).toBe(1);
  });

  it("selectScenario resets overrides to scenario defaults", () => {
    const restoredState = applyPreviewRuntimeCommand({
      state: createPreviewRuntimeState({
        runtimeInstanceId: "runtime-1",
        scenarios,
      }),
      command: {
        kind: "preview.command.restoreSession",
        runtimeInstanceId: "runtime-1",
        commandId: 1,
        selectedScenarioId: "default",
        argOverrides: {
          displayText: "Edited text",
        },
      },
      scenarios,
      validArgNames,
    });

    const nextState = applyPreviewRuntimeCommand({
      state: restoredState,
      command: {
        kind: "preview.command.selectScenario",
        runtimeInstanceId: "runtime-1",
        commandId: 2,
        scenarioId: "icon-only",
      },
      scenarios,
      validArgNames,
    });

    expect(nextState.selectedScenarioId).toBe("icon-only");
    expect(nextState.argOverrides).toEqual({});
    expect(nextState.lastAppliedCommandId).toBe(2);
  });

  it("setArgsPartial merges over existing overrides", () => {
    const restoredState = applyPreviewRuntimeCommand({
      state: createPreviewRuntimeState({
        runtimeInstanceId: "runtime-1",
        scenarios,
      }),
      command: {
        kind: "preview.command.restoreSession",
        runtimeInstanceId: "runtime-1",
        commandId: 1,
        selectedScenarioId: "default",
        argOverrides: {
          displayText: "Copy",
        },
      },
      scenarios,
      validArgNames,
    });

    const nextState = applyPreviewRuntimeCommand({
      state: restoredState,
      command: {
        kind: "preview.command.setArgsPartial",
        runtimeInstanceId: "runtime-1",
        commandId: 2,
        argsPartial: {
          displayText: "",
          showText: false,
        },
      },
      scenarios,
      validArgNames,
    });

    expect(nextState.argOverrides).toEqual({
      displayText: "",
      showText: false,
    });
    expect(nextState.lastAppliedCommandId).toBe(2);
  });
});
