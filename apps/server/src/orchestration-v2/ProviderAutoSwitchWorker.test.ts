import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";

import { autoSwitchCommands } from "./ProviderAutoSwitchWorker.ts";

const runId = RunId.make("run:1");
const selection = (instanceId: string) => ({
  instanceId: ProviderInstanceId.make(instanceId),
  model: "model",
});
const provider = (instanceId: string, sessionUsed: number): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-18T00:00:00.000Z",
  models: [{ slug: "model", name: "Model", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
  usageLimits: {
    checkedAt: "2026-11-18T00:00:00.000Z",
    windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: sessionUsed }],
  },
});
const thread = (status: "completed" | "failed", lastErrorClass: "usage_limit" | null = null) =>
  ({
    id: ThreadId.make("thread:1"),
    status,
    lastErrorClass,
    latestRunId: runId,
    archivedAt: null,
    settledOverride: null,
    pendingRuntimeRequest: null,
    lineage: { relationshipToParent: null, parentThreadId: null },
    modelSelection: selection("work"),
  }) as Parameters<typeof autoSwitchCommands>[0]["thread"];
const settings = {
  ...DEFAULT_SERVER_SETTINGS.providerAutoSwitch,
  mode: "route" as const,
  trigger: "session" as const,
  thresholdPercent: 80,
  route: [selection("work"), selection("personal")],
};
const commandTypes = (input: Partial<Parameters<typeof autoSwitchCommands>[0]>) =>
  autoSwitchCommands({
    thread: thread("completed"),
    runId,
    settings,
    providers: [provider("work", 85), provider("personal", 10)],
    ...input,
  }).map((command) => command.type);

describe("autoSwitchCommands", () => {
  it("switches and continues a run that hit its usage limit", () => {
    const commands = autoSwitchCommands({
      thread: thread("failed", "usage_limit"),
      runId,
      settings: { ...settings, trigger: "exhausted" },
      providers: [provider("work", 100), provider("personal", 10)],
    });
    assert.deepStrictEqual(
      commands.map((command) => command.type),
      ["provider.switch", "message.dispatch"],
    );
    assert.deepStrictEqual(
      commands[0]?.type === "provider.switch" ? commands[0].modelSelection : null,
      selection("personal"),
    );
  });

  it("switches without continuing a completed run past the threshold", () => {
    assert.deepStrictEqual(commandTypes({}), ["provider.switch"]);
    assert.deepStrictEqual(commandTypes({ providers: [provider("work", 50)] }), []);
  });

  it("does nothing outside route mode, for stale runs, or with no usable target", () => {
    assert.deepStrictEqual(commandTypes({ settings: { ...settings, mode: "ask" } }), []);
    assert.deepStrictEqual(commandTypes({ runId: RunId.make("run:old") }), []);
    assert.deepStrictEqual(
      commandTypes({ providers: [provider("work", 85), provider("personal", 95)] }),
      [],
    );
  });
});
