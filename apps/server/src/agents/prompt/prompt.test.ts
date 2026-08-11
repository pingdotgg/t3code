import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  AgentProfileId,
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
  assert.throws(() => normalizeWorkspaceRelativePath("https://example.com/index.ts"));
  assert.throws(() => normalizeWorkspaceRelativePath("file:src/index.ts"));
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

it("does not match archived rules", () => {
  const archived = makeRule("archived", "stale guidance", {
    alwaysApply: true,
    archivedAt: "2026-01-01T00:00:00.000Z",
  });
  const active = makeRule("active", "current guidance", { alwaysApply: true });

  const result = matchAgentRules({ rules: [archived, active], profile });

  assert.deepEqual(
    result.rules.map((rule) => rule.id),
    ["active"],
  );
});

it("matches explicit rule references by scope and source path", () => {
  const referencedPath = ".t3code/rules/reviewer.md";
  const projectProfile = {
    ...profile,
    scope: "project" as const,
    rules: [{ id: profile.id, path: referencedPath }],
  };
  const environmentRule = makeRule("reviewer", "environment guidance", {
    sourcePath: null,
  });
  const projectRule = makeRule("reviewer", "project guidance", {
    scope: "project",
    sourcePath: referencedPath,
  });

  const result = matchAgentRules({
    rules: [environmentRule, projectRule],
    profile: projectProfile,
  });

  assert.deepEqual(
    result.rules.map((rule) => `${rule.scope}/${rule.id}`),
    ["project/reviewer"],
  );
});

it("matches an environment profile's explicit environment rule reference", () => {
  const environmentRule = makeRule("reviewer", "environment guidance", {
    sourcePath: null,
  });
  const result = matchAgentRules({
    rules: [environmentRule],
    profile: {
      ...profile,
      rules: [{ id: AgentProfileId.make(environmentRule.id), path: "rules/reviewer.md" }],
    },
  });

  assert.deepEqual(
    result.rules.map((rule) => `${rule.scope}/${rule.id}`),
    ["environment/reviewer"],
  );
});

it("matches the supported glob syntax without a regexp backtracking engine", () => {
  const rule = makeRule("glob-syntax", "glob guidance", {
    globs: ["src/**/{api,worker}/file-?.[tj]s"],
  });

  const result = matchAgentRules({
    rules: [rule],
    contextFiles: ["src/nested/deeper/api/file-a.ts", "src/worker/file-z.js"],
  });

  assert.deepEqual(
    result.rules.map((candidate) => candidate.id),
    ["glob-syntax"],
  );
  assert.deepEqual(result.diagnostics, []);
});

it("keeps character classes inside a single path segment", () => {
  const rule = makeRule("class-boundary", "class guidance", {
    globs: ["src[/-]secret.ts"],
  });

  const result = matchAgentRules({
    rules: [rule],
    contextFiles: ["src/secret.ts"],
  });

  assert.deepEqual(result.rules, []);
  assert.deepEqual(result.diagnostics, []);
});

it("matches zero or more complete directories for a deep-star directory", () => {
  const rule = makeRule("directory-boundary", "directory guidance", {
    globs: ["**/foo.ts"],
  });

  const prefix = matchAgentRules({ rules: [rule], contextFiles: ["prefixfoo.ts"] });
  const directories = matchAgentRules({
    rules: [rule],
    contextFiles: ["foo.ts", "nested/deeper/foo.ts"],
  });

  assert.deepEqual(prefix.rules, []);
  assert.deepEqual(
    directories.rules.map((candidate) => candidate.id),
    ["directory-boundary"],
  );
  assert.deepEqual(directories.diagnostics, []);
});

it("bounds non-matching overlapping wildcards by visiting each pattern/path state once", () => {
  const rule = makeRule("repeated-wildcards", "bounded guidance", {
    globs: [`${"**a".repeat(48)}z`],
  });

  const result = matchAgentRules({
    rules: [rule],
    contextFiles: [`${"a".repeat(400)}y`],
  });

  assert.deepEqual(result.rules, []);
  assert.deepEqual(result.diagnostics, []);
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

it("counts rule headers, separators, and UTF-8 bodies toward the content cap", () => {
  const alpha = makeRule("alpha", "é", { alwaysApply: true });
  const beta = makeRule("beta", "second", { alwaysApply: true });
  const expected =
    "<!-- t3-agent-rule: environment/alpha -->\né\n\n" +
    "<!-- t3-agent-rule: environment/beta -->\nsecond";
  const expectedBytes = new TextEncoder().encode(expected).byteLength;

  let overflow: unknown;
  try {
    compileAgentRules({ rules: [alpha] }, 2);
  } catch (error) {
    overflow = error;
  }
  assert.isTrue(isAgentRuleContentOverflowError(overflow));

  const result = compileAgentRules({ rules: [alpha, beta] }, expectedBytes);
  assert.equal(result.content, expected);
  assert.equal(result.contentBytes, expectedBytes);
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
