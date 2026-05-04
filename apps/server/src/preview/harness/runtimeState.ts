import type { PreviewControlDefinition, PreviewScenarioDefinition } from "./types.ts";

export interface PreviewRuntimeState {
  runtimeInstanceId: string;
  selectedScenarioId: string;
  argOverrides: Record<string, unknown>;
  lastAppliedCommandId: number;
}

export type PreviewRuntimeCommand =
  | {
      kind: "preview.command.restoreSession";
      runtimeInstanceId: string;
      commandId: number;
      selectedScenarioId: string | null;
      argOverrides: Record<string, unknown>;
    }
  | {
      kind: "preview.command.selectScenario";
      runtimeInstanceId: string;
      commandId: number;
      scenarioId: string;
    }
  | {
      kind: "preview.command.setArgsPartial";
      runtimeInstanceId: string;
      commandId: number;
      argsPartial: Record<string, unknown>;
    };

export function buildPreviewRuntimeArgNameSet(input: {
  controls: readonly PreviewControlDefinition[] | undefined;
  scenarios: readonly PreviewScenarioDefinition[];
}): Set<string> {
  const argNames = new Set<string>();

  for (const control of input.controls ?? []) {
    argNames.add(control.name);
  }
  for (const scenario of input.scenarios) {
    for (const argName of Object.keys(scenario.args ?? {})) {
      argNames.add(argName);
    }
  }

  return argNames;
}

export function sanitizePreviewRuntimeArgOverrides(
  argOverrides: Readonly<Record<string, unknown>>,
  validArgNames: ReadonlySet<string>,
): Record<string, unknown> {
  const nextArgOverrides: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(argOverrides)) {
    if (validArgNames.has(name)) {
      nextArgOverrides[name] = value;
    }
  }
  return nextArgOverrides;
}

export function createPreviewRuntimeState(input: {
  runtimeInstanceId: string;
  scenarios: readonly PreviewScenarioDefinition[];
}): PreviewRuntimeState {
  return {
    runtimeInstanceId: input.runtimeInstanceId,
    selectedScenarioId: input.scenarios[0]?.id ?? "default",
    argOverrides: {},
    lastAppliedCommandId: 0,
  };
}

export function applyPreviewRuntimeCommand(input: {
  state: PreviewRuntimeState;
  command: PreviewRuntimeCommand;
  scenarios: readonly PreviewScenarioDefinition[];
  validArgNames: ReadonlySet<string>;
}): PreviewRuntimeState {
  const { state, command, scenarios, validArgNames } = input;

  if (command.runtimeInstanceId !== state.runtimeInstanceId) {
    return state;
  }
  if (command.commandId <= state.lastAppliedCommandId) {
    return state;
  }

  const nextStateBase = {
    ...state,
    lastAppliedCommandId: command.commandId,
  };

  if (command.kind === "preview.command.restoreSession") {
    const nextScenarioId =
      command.selectedScenarioId &&
      scenarios.some((scenario) => scenario.id === command.selectedScenarioId)
        ? command.selectedScenarioId
        : state.selectedScenarioId;
    return {
      ...nextStateBase,
      selectedScenarioId: nextScenarioId,
      argOverrides: sanitizePreviewRuntimeArgOverrides(command.argOverrides, validArgNames),
    };
  }

  if (command.kind === "preview.command.selectScenario") {
    const nextScenarioId = scenarios.some((scenario) => scenario.id === command.scenarioId)
      ? command.scenarioId
      : state.selectedScenarioId;
    return {
      ...nextStateBase,
      selectedScenarioId: nextScenarioId,
      argOverrides: {},
    };
  }

  return {
    ...nextStateBase,
    argOverrides: {
      ...state.argOverrides,
      ...sanitizePreviewRuntimeArgOverrides(command.argsPartial, validArgNames),
    },
  };
}
