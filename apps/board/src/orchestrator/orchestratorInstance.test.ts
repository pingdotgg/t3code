import { ProviderDriverKind, ProviderInstanceId, type ServerSettings } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  baseInstanceId,
  isOrchestratorInstance,
  orchestratorInstanceId,
  planOrchestratorInstance,
} from "./orchestratorInstance";

const RULES = 'Rule one.\nUse "quotes", $HOME, `ticks`, and a \\ backslash.\n';

const claude = { instanceId: "claudeAgent", driver: "claudeAgent" };
const claudeAlt = ProviderInstanceId.make("claude_alt");
const claudeDriver = ProviderDriverKind.make("claudeAgent");

const instances = (
  entries: Record<string, ServerSettings["providerInstances"][ProviderInstanceId]>,
): ServerSettings["providerInstances"] =>
  Object.fromEntries(
    Object.entries(entries).map(([id, instance]) => [ProviderInstanceId.make(id), instance]),
  );

const written = (plan: ReturnType<typeof planOrchestratorInstance>) => {
  if (plan.mutation === null || plan.mutation.operation === "remove") throw new Error("no write");
  return plan.mutation.instance;
};

describe("the orchestrator instance", () => {
  it("Given fixed rules and no instance yet, when it is planned, then the launch arguments are the literal rules and the disallowed tools", () => {
    const plan = planOrchestratorInstance({
      providerInstances: instances({}),
      base: claude,
      rules: RULES,
    });
    expect(plan.instanceId).toBe("board-orchestrator-claudeAgent");
    expect(plan.mutation).toEqual({
      operation: "upsert",
      instanceId: "board-orchestrator-claudeAgent",
      instance: {
        driver: "claudeAgent",
        displayName: "claudeAgent (board orchestrator)",
        enabled: true,
        config: {
          launchArgs:
            '--append-system-prompt "Rule one.\nUse \\"quotes\\", \\$HOME, \\`ticks\\`, and a \\\\ backslash.\n" --disallowedTools "Task,Agent"',
        },
      },
    });
  });

  it("Given a Codex instance, when it is planned, then the rules ride in developer_instructions as a TOML string", () => {
    const plan = planOrchestratorInstance({
      providerInstances: instances({}),
      base: { instanceId: "codex", driver: "codex" },
      rules: 'Say "hi".\nBye.',
    });
    expect(plan.mutation).toMatchObject({
      instance: {
        driver: "codex",
        config: { launchArgs: '-c "developer_instructions=\\"Say \\\\\\"hi\\\\\\".\\\\nBye.\\""' },
      },
    });
  });

  it("Given an orchestrator instance that already holds these rules, when it is planned, then nothing is written", () => {
    const first = planOrchestratorInstance({
      providerInstances: instances({}),
      base: claude,
      rules: RULES,
    });
    const settings = instances({
      "board-orchestrator-claudeAgent": written(first),
    });
    expect(
      planOrchestratorInstance({ providerInstances: settings, base: claude, rules: RULES }),
    ).toEqual({ instanceId: "board-orchestrator-claudeAgent", mutation: null });
  });

  it("Given changed rules, when it is planned, then the same instance id is updated and no second one is added", () => {
    const first = planOrchestratorInstance({
      providerInstances: instances({}),
      base: claude,
      rules: RULES,
    });
    const settings = instances({
      "board-orchestrator-claudeAgent": written(first),
    });
    const next = planOrchestratorInstance({
      providerInstances: settings,
      base: claude,
      rules: "New rules.",
    });
    expect(next.instanceId).toBe("board-orchestrator-claudeAgent");
    expect(next.mutation).toMatchObject({
      operation: "upsert",
      instanceId: "board-orchestrator-claudeAgent",
    });
  });

  it("Given another account with its own home and arguments, when it is planned, then the copy keeps them and every other instance is untouched", () => {
    const providerInstances = instances({
      claude_alt: {
        driver: claudeDriver,
        displayName: "Work",
        environment: [{ name: "A", value: "1", sensitive: false }],
        config: { homePath: "/home/me/.claude-work", launchArgs: "--chrome" },
      },
      claudeAgent: { driver: claudeDriver, config: { homePath: "/home/me/.claude" } },
    });
    const before = structuredClone(providerInstances);
    const plan = planOrchestratorInstance({
      providerInstances,
      base: { instanceId: claudeAlt, driver: "claudeAgent" },
      rules: "R",
    });
    expect(plan.instanceId).toBe("board-orchestrator-claude_alt");
    expect(plan.mutation).toMatchObject({
      instanceId: "board-orchestrator-claude_alt",
      instance: {
        displayName: "Work (board orchestrator)",
        environment: [{ name: "A", value: "1", sensitive: false }],
        config: {
          homePath: "/home/me/.claude-work",
          launchArgs: '--chrome --append-system-prompt "R" --disallowedTools "Task,Agent"',
        },
      },
    });
    expect(providerInstances).toEqual(before);
  });

  it("Given a driver with no standing instructions, when it is planned, then it throws", () => {
    expect(() =>
      planOrchestratorInstance({
        providerInstances: instances({}),
        base: { instanceId: "cursor", driver: "cursor" },
        rules: RULES,
      }),
    ).toThrow("no orchestrator rules for cursor");
  });

  it("Given an orchestrator instance id, when it is read back, then it names the instance it copies", () => {
    expect(isOrchestratorInstance(orchestratorInstanceId("claude_alt"))).toBe(true);
    expect(isOrchestratorInstance("claudeAgent")).toBe(false);
    expect(baseInstanceId(orchestratorInstanceId("claude_alt"))).toBe("claude_alt");
    expect(baseInstanceId("claudeAgent")).toBe("claudeAgent");
  });
});
