import {
  ProviderDriverKind,
  ProviderInstanceId,
  type CustomOrchestrationSettings,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import { composerOrchestrator, withCustomOrchestrationCommands } from "./customOrchestration";
import { deriveProviderInstanceEntries } from "./providerInstances";

const NOW = Date.parse("2026-01-01T00:00:00.000Z");
const CLAUDE = ProviderDriverKind.make("claudeAgent");
const primary = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "model-a" };
const fallback = { instanceId: ProviderInstanceId.make("codex"), model: "model-b" };

const provider = (
  selection: typeof primary,
  changes: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId: selection.instanceId,
  driver: ProviderDriverKind.make(selection.instanceId),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [{ slug: selection.model, name: selection.model, isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
  ...changes,
});

const atLimit: Partial<ServerProvider> = {
  usageLimits: {
    checkedAt: "2026-01-01T00:00:00.000Z",
    windows: [
      {
        id: "session",
        label: "Session",
        kind: "session",
        usedPercent: 100,
        resetsAt: "2026-01-01T05:00:00.000Z",
      },
    ],
  },
};

const resolve = (input: {
  readonly claude?: Partial<ServerProvider>;
  readonly codex?: Partial<ServerProvider>;
  readonly fallbacks?: ReadonlyArray<typeof fallback>;
  readonly lockedProvider?: ProviderDriverKind;
}) =>
  composerOrchestrator({
    settings: {
      ...DEFAULT_UNIFIED_SETTINGS,
      customOrchestration: {
        orchestrator: { modelSelection: primary, fallbacks: input.fallbacks ?? [fallback] },
        tasks: [],
        commands: [],
      },
    },
    entries: deriveProviderInstanceEntries([
      provider(primary, input.claude),
      provider(fallback, input.codex),
    ]),
    projectId: null,
    now: NOW,
    lockedProvider: input.lockedProvider ?? null,
    lockedContinuationGroupKey: null,
  });

describe("composerOrchestrator", () => {
  it("blocks sending until an orchestrator is configured", () => {
    const result = composerOrchestrator({
      settings: DEFAULT_UNIFIED_SETTINGS,
      entries: [],
      projectId: null,
      now: NOW,
      lockedProvider: null,
      lockedContinuationGroupKey: null,
    });

    expect(result.selection).toBeNull();
    expect(result.blockReason).toContain("Choose an orchestrator model");
  });

  it("runs the orchestrator while it can", () => {
    expect(resolve({})).toEqual({ selection: primary, blockReason: null, standingIn: null });
  });

  it("names the fallback standing in for an orchestrator at its limit", () => {
    expect(resolve({ claude: atLimit })).toEqual({
      selection: fallback,
      blockReason: null,
      standingIn: { primary, problem: expect.objectContaining({ kind: "limit" }) },
    });
  });

  it("lets the provider report the limit when every model is at one", () => {
    expect(resolve({ claude: atLimit, codex: atLimit })).toEqual({
      selection: primary,
      blockReason: null,
      standingIn: null,
    });
  });

  it("blocks sending when no configured model can run", () => {
    const result = resolve({ claude: { enabled: false }, codex: { enabled: false } });

    expect(result.selection).toEqual(primary);
    expect(result.blockReason).toContain("provider is unavailable");
  });

  it("skips a model the thread is locked away from", () => {
    expect(resolve({ fallbacks: [], lockedProvider: ProviderDriverKind.make("codex") })).toEqual({
      selection: primary,
      blockReason: expect.stringContaining("cannot switch"),
      standingIn: null,
    });
    expect(resolve({ claude: atLimit, lockedProvider: CLAUDE }).selection).toEqual(primary);
  });
});

describe("withCustomOrchestrationCommands", () => {
  const reviewers = [{ modelSelection: primary, fallbacks: [] }];
  const settings: CustomOrchestrationSettings = {
    orchestrator: null,
    tasks: [],
    commands: [
      { name: "extreme-review", instructions: "", reviewers },
      { name: "empty", instructions: "", reviewers: [] },
      { name: "review", instructions: "", reviewers },
    ],
  };

  it("lists runnable commands first and leaves the harness its own", () => {
    const listed = withCustomOrchestrationCommands(
      [{ name: "extreme-review" }, { name: "review" }],
      settings,
    );

    expect(listed.map((command) => command.name)).toEqual(["extreme-review", "review"]);
    expect(listed[0]?.description).toBe("Review by 1 model");
    expect(listed[1]).toEqual({ name: "review" });
  });
});
