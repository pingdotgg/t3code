import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  AgentProfileDocument,
  AgentRuleDocument,
  type AgentProfileDocument as AgentProfileDocumentType,
  type AgentRuleDocument as AgentRuleDocumentType,
} from "@t3tools/contracts";

import {
  compileAgentPrompt,
  compileAgentRules,
  isAgentRuleContentOverflowError,
  matchAgentRules,
  normalizeWorkspaceRelativePath,
} from "./index.ts";

const revision = "a".repeat(64);
const decodeAgentProfileDocument = Schema.decodeUnknownSync(AgentProfileDocument);
const decodeAgentRuleDocument = Schema.decodeUnknownSync(AgentRuleDocument);

const profile: AgentProfileDocumentType = decodeAgentProfileDocument({
  id: "reviewer",
  scope: "environment",
  revision,
  name: "Reviewer",
  defaultModelSelection: null,
  sourcePath: null,
  requirements: { toolRequirement: "none", t3McpCapabilities: [] },
  archivedAt: null,
  updatedAt: "1970-01-01T00:00:00.000Z",
  instructions: "Inspect the change carefully.",
  instructionPriority: "prompt",
  runtime: { mode: "auto", interactionMode: "default" },
  workspace: { mode: "shared", access: "read-only" },
  tools: { policy: "inherit", allowed: [] },
  delegation: { policy: "disabled", profiles: [] },
  budgets: { maxRuns: 1, maxConcurrency: 1, maxDepth: 0, maxWallTimeMinutes: 1 },
  hooks: [],
  rules: [],
  createdAt: "1970-01-01T00:00:00.000Z",
});

const makeRule = (
  id: string,
  body: string,
  overrides: Readonly<Record<string, unknown>> = {},
): AgentRuleDocumentType =>
  decodeAgentRuleDocument({
    id,
    scope: "environment",
    revision,
    name: id,
    globs: [],
    alwaysApply: false,
    priority: 0,
    sourcePath: null,
    updatedAt: "1970-01-01T00:00:00.000Z",
    archivedAt: null,
    body,
    profiles: [],
    createdAt: "1970-01-01T00:00:00.000Z",
    ...overrides,
  });

it("normalizes workspace-relative paths without filesystem access", () => {
  assert.equal(normalizeWorkspaceRelativePath("src\\components\\..\\index.ts"), "src/index.ts");
  assert.throws(() => normalizeWorkspaceRelativePath("../outside.ts"));
});

it("matches always-apply, targeted, and glob rules in deterministic order", () => {
  const always = makeRule("always", "always", { alwaysApply: true, priority: 0 });
  const targeted = makeRule("targeted", "targeted", {
    profiles: [{ id: "reviewer", scope: "environment" }],
    priority: 10,
  });
  const glob = makeRule("glob", "glob", { globs: ["**/*.ts"], priority: 20 });
  const result = matchAgentRules({
    rules: [always, glob, targeted],
    profile,
    contextFiles: ["src\\index.ts"],
  });
  assert.deepEqual(
    result.rules.map((rule) => rule.id),
    ["glob", "targeted", "always"],
  );
});

it("fails with a typed error when compiled rule content exceeds the cap", () => {
  const rule = makeRule("large", "12345", { alwaysApply: true });
  let error: unknown;
  try {
    compileAgentRules({ rules: [rule] }, 4);
  } catch (caught) {
    error = caught;
  }
  assert.isTrue(isAgentRuleContentOverflowError(error));
  assert.equal((error as { limitBytes?: number }).limitBytes, 4);
});

it("compiles a stable envelope while preserving the clean task", () => {
  const result = compileAgentPrompt({
    profile,
    cleanTask: "  Keep this task exactly as written.  ",
    context: "The relevant context.",
    files: ["src\\index.ts"],
    rules: [makeRule("always", "Use inferred types.", { alwaysApply: true })],
    lineage: { depth: 1 },
    toolNames: ["search", "edit", "search"],
  });
  assert.equal(result.portablePrompt.task, "  Keep this task exactly as written.  ");
  assert.include(result.nativeInstructions, "Inspect the change carefully.");
  assert.include(result.nativeInstructions, "Use inferred types.");
  assert.include(result.portablePrompt.text, "You are running inside T3 Code");
  assert.include(result.portablePrompt.text, "agent_spawn");
  assert.include(result.portablePrompt.text, "## Task\n  Keep this task exactly as written.  ");
  assert.equal(result.portablePromptEnvelope, result.portablePrompt);
  assert.deepEqual(
    result.hashes,
    compileAgentPrompt({
      profile,
      cleanTask: "  Keep this task exactly as written.  ",
      context: "The relevant context.",
      files: ["src/index.ts"],
      rules: [makeRule("always", "Use inferred types.", { alwaysApply: true })],
      lineage: { depth: 1 },
      toolNames: ["edit", "search"],
    }).hashes,
  );
});
