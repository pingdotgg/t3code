import type { AgentSelection } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import {
  buildCreatePrompt,
  containsForbiddenStepType,
  injectAgentIntoSteps,
} from "./createWorkflowPrompt.ts";

const agent: AgentSelection = { instance: "claude_main", model: "sonnet" };

describe("buildCreatePrompt", () => {
  it("includes the board name, the description, and the fenced-json output instruction", () => {
    const prompt = buildCreatePrompt({
      name: "My Board",
      description: "I triage bugs then fix them.",
      agent,
    });
    assert.include(prompt, "My Board");
    assert.include(prompt, "I triage bugs then fix them.");
    assert.include(prompt, '```json block with `{ "proposedDefinition"');
    assert.include(prompt, "rationale");
  });

  it("FORBIDS executable step types in the instruction text", () => {
    const prompt = buildCreatePrompt({ name: "B", description: "d", agent });
    assert.include(prompt, "script");
    assert.include(prompt, "merge");
    assert.include(prompt, "pullRequest");
  });

  it("teaches the exact shape: the strict enums + required fields the decoder enforces", () => {
    const prompt = buildCreatePrompt({ name: "B", description: "d", agent });
    // The two strict enums GPT most often guesses wrong.
    assert.include(prompt, '"auto" or "manual"');
    assert.include(prompt, '"agent" or "approval"');
    // The required keys + the reachable-terminal rule + the loop guard.
    assert.include(prompt, "terminal");
    assert.include(prompt, "lane.runCount");
  });

  it("includes a complete worked example board the model can pattern-match", () => {
    const prompt = buildCreatePrompt({ name: "B", description: "d", agent });
    assert.include(prompt, "Worked example");
    assert.include(prompt, '"entry": "auto"');
    assert.include(prompt, '"type": "agent"');
    assert.include(prompt, '"terminal": true');
  });

  it("redacts a high-entropy token seeded into the description (defence-in-depth)", () => {
    // sk- pattern triggers the OpenAI key redaction in redactSensitiveText.
    const token = "sk-" + "ABCdef0123456789ABCdef0123456789";
    const prompt = buildCreatePrompt({
      name: "Board",
      description: `My agent uses ${token} to do things`,
      agent,
    });
    assert.notInclude(prompt, token);
    assert.include(prompt, "[redacted]");
  });
});

describe("injectAgentIntoSteps", () => {
  it("injects the chosen agent into an agent step that omits `agent` entirely", () => {
    const raw = {
      name: "B",
      lanes: [
        {
          key: "work",
          pipeline: [{ key: "code", type: "agent", instruction: "do it" }],
        },
      ],
    };
    const out = injectAgentIntoSteps(raw, agent) as typeof raw;
    const step = out.lanes[0]!.pipeline[0] as unknown as { readonly agent: unknown };
    assert.deepEqual(step.agent, { instance: "claude_main", model: "sonnet" });
  });

  it("OVERWRITES a different agent the model emitted", () => {
    const raw = {
      lanes: [
        {
          key: "work",
          pipeline: [
            {
              key: "code",
              type: "agent",
              instruction: "do it",
              agent: { instance: "other_inst", model: "opus" },
            },
          ],
        },
      ],
    };
    const out = injectAgentIntoSteps(raw, agent) as typeof raw;
    assert.deepEqual(out.lanes[0]!.pipeline[0]!.agent, {
      instance: "claude_main",
      model: "sonnet",
    });
  });

  it("threads options through and removes retry.escalate", () => {
    const withOptions: AgentSelection = {
      instance: "claude_main",
      model: "sonnet",
      options: [{ optionId: "reasoning", valueId: "high" }] as never,
    };
    const raw = {
      lanes: [
        {
          key: "work",
          pipeline: [
            {
              key: "code",
              type: "agent",
              instruction: "do it",
              agent: { instance: "x", model: "y" },
              retry: { maxAttempts: 3, escalate: { instance: "esc", model: "opus" } },
            },
          ],
        },
      ],
    };
    const out = injectAgentIntoSteps(raw, withOptions) as {
      lanes: Array<{
        pipeline: Array<{
          agent: { instance: string; model: string; options?: unknown };
          retry: Record<string, unknown>;
        }>;
      }>;
    };
    const step = out.lanes[0]!.pipeline[0]!;
    assert.equal(step.agent.instance, "claude_main");
    assert.deepEqual(step.agent.options, withOptions.options);
    assert.equal(step.retry.maxAttempts, 3);
    assert.notProperty(step.retry, "escalate");
  });

  it("leaves approval steps and manual lanes untouched", () => {
    const raw = {
      lanes: [
        { key: "backlog", entry: "manual" },
        {
          key: "review",
          pipeline: [{ key: "approve", type: "approval", prompt: "ok?" }],
        },
      ],
    };
    const out = injectAgentIntoSteps(raw, agent) as {
      lanes: Array<{ key: string; entry?: string; pipeline?: Array<Record<string, unknown>> }>;
    };
    assert.notProperty(out.lanes[1]!.pipeline![0]!, "agent");
    assert.deepEqual(out.lanes[0], { key: "backlog", entry: "manual" });
  });

  it("returns non-object / malformed input unchanged without throwing", () => {
    assert.equal(injectAgentIntoSteps(null, agent), null);
    assert.equal(injectAgentIntoSteps(42, agent), 42);
    assert.deepEqual(injectAgentIntoSteps({ lanes: "nope" }, agent), { lanes: "nope" });
    assert.deepEqual(injectAgentIntoSteps({}, agent), {});
  });
});

describe("containsForbiddenStepType", () => {
  for (const forbidden of ["script", "merge", "pullRequest"] as const) {
    it(`returns true when a step has type "${forbidden}"`, () => {
      const raw = {
        lanes: [{ key: "w", pipeline: [{ key: "s", type: forbidden }] }],
      };
      assert.isTrue(containsForbiddenStepType(raw));
    });
  }

  it("returns false for an agent+approval-only def", () => {
    const raw = {
      lanes: [
        { key: "w", pipeline: [{ key: "a", type: "agent" }] },
        { key: "r", pipeline: [{ key: "b", type: "approval" }] },
      ],
    };
    assert.isFalse(containsForbiddenStepType(raw));
  });

  it("is defensive on junk input", () => {
    assert.isFalse(containsForbiddenStepType(null));
    assert.isFalse(containsForbiddenStepType(42));
    assert.isFalse(containsForbiddenStepType({ lanes: "nope" }));
    assert.isFalse(containsForbiddenStepType({}));
  });
});
