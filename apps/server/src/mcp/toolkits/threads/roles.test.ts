import {
  DEFAULT_PRISM_ROLE_KITS,
  prismRoleFromName,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  isProviderBlocked,
  pickRoleModel,
  prismRoleSuffix,
  roleTaskMessage,
  threadRoleOf,
  threadToolRefusal,
  threadToolScopeOf,
} from "./roles.ts";
import { makeSubagentThreadId } from "./subagentThreadId.ts";
import { SpawnThreadInput } from "./tools.ts";

const decodeSpawnInput = Schema.decodeUnknownSync(SpawnThreadInput);
const child = (role: string) => makeSubagentThreadId("planner-1", `${role}-abc123`);

describe("thread roles", () => {
  it("treats a thread the user started as the planner", () => {
    expect(threadRoleOf("planner-1")).toBe("planner");
  });

  it("reads a role spawned child's role from its id", () => {
    expect(threadRoleOf(makeSubagentThreadId("planner-1", prismRoleSuffix("reviewer", "a1")))).toBe(
      "reviewer",
    );
    expect(threadRoleOf(child("dispatcher"))).toBe("dispatcher");
    expect(threadRoleOf(makeSubagentThreadId(child("dispatcher"), "worker-9f"))).toBe("worker");
  });

  it("spawns Retry and Escalation under their stable keys, old names too", () => {
    const spawnedRole = (role: string) => {
      const input = decodeSpawnInput({ task: "Fix it.", role });
      return threadRoleOf(
        makeSubagentThreadId("planner-1", prismRoleSuffix(prismRoleFromName(input.role!), "a1")),
      );
    };
    expect(spawnedRole("retry")).toBe("correction");
    expect(spawnedRole("correction")).toBe("correction");
    expect(spawnedRole("escalation")).toBe("recovery");
    expect(spawnedRole("recovery")).toBe("recovery");
  });

  it("leaves children without a role prefix unassigned", () => {
    expect(threadRoleOf(makeSubagentThreadId("planner-1", "0123456789ab"))).toBe("unassigned");
    expect(threadRoleOf(makeSubagentThreadId("planner-1", "tester-1"))).toBe("unassigned");
  });
});

describe("thread tool scope per role", () => {
  const scopeOf = (threadId: string) => threadToolScopeOf(threadId, DEFAULT_PRISM_ROLE_KITS);
  const tools = [
    "spawn_thread",
    "message_thread",
    "read_thread",
    "list_child_threads",
    "list_threads",
  ] as const;
  const allowed = (threadId: string, scope: "children" | "project") =>
    tools.filter((tool) => threadToolRefusal(scopeOf(threadId), tool, scope) === null);

  it("gives the planner every tool with project scope", () => {
    expect(allowed("planner-1", "project")).toEqual(tools);
  });

  it("limits a dispatcher to reading and messaging its own children", () => {
    expect(allowed(child("dispatcher"), "children")).toEqual([
      "message_thread",
      "read_thread",
      "list_child_threads",
      "list_threads",
    ]);
    expect(allowed(child("dispatcher"), "project")).toEqual([]);
  });

  it("lets a reviewer read the project but not write", () => {
    expect(allowed(child("reviewer"), "project")).toEqual([
      "read_thread",
      "list_child_threads",
      "list_threads",
    ]);
  });

  it("gives workers, corrections and recoveries no thread tools", () => {
    for (const role of ["worker", "correction", "recovery"]) {
      expect(allowed(child(role), "children")).toEqual([]);
    }
  });

  it("keeps the old behavior for unassigned children", () => {
    expect(allowed(makeSubagentThreadId("planner-1", "0123456789ab"), "project")).toEqual(tools);
  });

  it("follows a kit that changes a role's scope", () => {
    const kits = {
      ...DEFAULT_PRISM_ROLE_KITS,
      worker: { ...DEFAULT_PRISM_ROLE_KITS.worker, threadTools: "project-read" as const },
    };
    expect(threadToolScopeOf(child("worker"), kits)).toBe("project-read");
  });
});

const provider = (overrides: Partial<ServerProvider> = {}): ServerProvider =>
  ({
    instanceId: "opencode",
    driver: "opencode",
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-25T00:00:00.000Z",
    models: [{ slug: "opencode/muse", name: "Muse", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
    ...overrides,
  }) as ServerProvider;

const window = (usedPercent: number, resetsAt?: string) => ({
  id: "five_hour",
  kind: "session" as const,
  label: "5h",
  usedPercent,
  ...(resetsAt ? { resetsAt } : {}),
});

describe("role model eligibility", () => {
  const now = Date.parse("2026-09-25T12:00:00.000Z");
  const muse = { instanceId: "opencode", model: "opencode/muse", effort: "high" } as never;
  const luna = { instanceId: "codex", model: "gpt-5.6-luna" } as never;

  it("picks the first preference enabled in Providers", () => {
    expect(pickRoleModel([luna, muse], [provider()], now)).toEqual({ pick: muse });
  });

  it("skips a disabled instance and a model the instance does not offer", () => {
    const result = pickRoleModel(
      [muse, { instanceId: "opencode", model: "opencode/other" } as never],
      [provider({ enabled: false })],
      now,
    );
    expect(result).toEqual({
      refusal:
        "No eligible model for this role and lane: opencode/opencode/muse (instance disabled), opencode/opencode/other (instance disabled).",
    });
    expect(
      pickRoleModel([{ instanceId: "opencode", model: "x" } as never], [provider()], now),
    ).toEqual({
      refusal: "No eligible model for this role and lane: opencode/x (model not offered).",
    });
  });

  it("blocks an instance at 100 % until its window resets", () => {
    const exhausted = provider({
      usageLimits: {
        checkedAt: "2026-09-25T11:59:00.000Z",
        windows: [window(100, "2026-09-25T13:00:00.000Z")],
      },
    });
    expect(isProviderBlocked(exhausted, now)).toBe(true);
    expect(isProviderBlocked(exhausted, Date.parse("2026-09-25T13:00:01.000Z"))).toBe(false);
    expect("refusal" in pickRoleModel([muse], [exhausted], now)).toBe(true);
  });

  it("falls back down a lane list, with one model at two efforts as separate entries", () => {
    const opusMedium = {
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
      effort: "medium",
    } as never;
    const opusXhigh = { ...(opusMedium as object), effort: "xhigh" } as never;
    const claude = provider({
      instanceId: "claudeAgent" as never,
      driver: "claudeAgent" as never,
      models: [{ slug: "claude-opus-5-5", name: "Opus", isCustom: false, capabilities: null }],
      usageLimits: {
        checkedAt: "2026-09-25T11:59:00.000Z",
        windows: [window(100, "2026-09-25T13:00:00.000Z")],
      },
    });
    expect(pickRoleModel([opusXhigh, opusMedium], [claude], now)).toEqual({
      refusal:
        "No eligible model for this role and lane: claudeAgent/claude-opus-5-5 (usage limit reached), claudeAgent/claude-opus-5-5 (usage limit reached).",
    });
    expect(pickRoleModel([opusXhigh, muse], [claude, provider()], now)).toEqual({ pick: muse });
    expect(
      pickRoleModel([opusXhigh, opusMedium], [{ ...claude, usageLimits: undefined }], now),
    ).toEqual({ pick: opusXhigh });
  });

  it("blocks a full window without resetsAt until the next reading, not below 100 %", () => {
    const noReset = provider({
      usageLimits: { checkedAt: "2026-09-25T11:59:00.000Z", windows: [window(100)] },
    });
    expect(isProviderBlocked(noReset, now)).toBe(true);
    const busy = provider({
      usageLimits: { checkedAt: "2026-09-25T11:59:00.000Z", windows: [window(85)] },
    });
    expect(isProviderBlocked(busy, now)).toBe(false);
  });
});

describe("role task message", () => {
  it("puts the kit's instructions and skills before the task", () => {
    const kit = {
      ...DEFAULT_PRISM_ROLE_KITS.reviewer,
      instructions: "Review only; do not edit.",
      skills: ["code-review"],
    };
    expect(roleTaskMessage(kit, "Review PR 12.")).toBe(
      "Review only; do not edit.\n\nUse these skills: code-review.\n\nReview PR 12.",
    );
  });

  it("sends the bare task for an empty kit", () => {
    expect(roleTaskMessage(DEFAULT_PRISM_ROLE_KITS.worker, "Fix it.")).toBe("Fix it.");
  });
});
