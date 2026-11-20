import { ProviderDriverKind, ProviderInstanceId, type ServerSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  baseInstanceId,
  isOrchestratorInstance,
  orchestratorInstanceId,
  planOrchestratorInstance,
  standingInstructions,
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

const decodeLaunchArgs = Schema.decodeUnknownSync(Schema.Struct({ launchArgs: Schema.String }));
const launchArgsOf = (instance: { readonly config?: unknown }) =>
  decodeLaunchArgs(instance.config).launchArgs;

describe("the orchestrator instance", () => {
  it("Given fixed rules and no instance yet, when it is planned, then the launch arguments carry poteto-mode, the adapter, and the rules in that order, then the disallowed tools", () => {
    const plan = planOrchestratorInstance({
      providerInstances: instances({}),
      base: claude,
      rules: RULES,
    });
    expect(plan.instanceId).toBe("board-orchestrator-claudeAgent");
    const instance = written(plan);
    expect(instance).toMatchObject({
      driver: "claudeAgent",
      displayName: "claudeAgent (board orchestrator)",
      enabled: true,
    });
    const launchArgs = launchArgsOf(instance);
    expect(launchArgs.startsWith('--append-system-prompt "# Poteto mode\n')).toBe(true);
    expect(
      launchArgs.endsWith(
        'Rule one.\nUse \\"quotes\\", \\$HOME, \\`ticks\\`, and a \\\\ backslash.\n" --disallowedTools "Task,Agent"',
      ),
    ).toBe(true);
    const at = (marker: string) => launchArgs.indexOf(marker);
    expect(at("# Poteto mode")).toBeLessThan(at("# pstack on T3"));
    expect(at("# pstack on T3")).toBeLessThan(at("Rule one."));
  });

  it("Given the standing instructions, when they are read, then each part is whole, front matter is gone, and the rules come last", () => {
    const text = standingInstructions("THE RULES");
    expect(text.startsWith("# Poteto mode\n")).toBe(true);
    expect(text).not.toContain("disable-model-invocation");
    expect(text).toContain("## Playbooks");
    expect(text).toContain("Start every child with `delegate_task`.");
    expect(text.endsWith("\n\nTHE RULES")).toBe(true);
    for (const omp of ["skill://", "agent://", "proc://", "history://", "OMP"]) {
      expect(text).not.toContain(omp);
    }
  });

  it("Given a Codex instance, when it is planned, then the rules ride in developer_instructions as a TOML string", () => {
    const plan = planOrchestratorInstance({
      providerInstances: instances({}),
      base: { instanceId: "codex", driver: "codex" },
      rules: 'Say "hi".\nBye.',
    });
    const instance = written(plan);
    expect(instance.driver).toBe("codex");
    const launchArgs = launchArgsOf(instance);
    expect(launchArgs.startsWith('-c "developer_instructions=\\"# Poteto mode\\\\n')).toBe(true);
    expect(launchArgs.endsWith('Say \\\\\\"hi\\\\\\".\\\\nBye.\\""')).toBe(true);
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
        config: { homePath: "/home/me/.claude-work" },
      },
    });
    const launchArgs = launchArgsOf(written(plan));
    expect(launchArgs.startsWith('--chrome --append-system-prompt "# Poteto mode\n')).toBe(true);
    expect(launchArgs.endsWith('\n\nR" --disallowedTools "Task,Agent"')).toBe(true);
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
