import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  AgentMcpSpawnInput,
  AgentMcpWaitInput,
  AgentProfile,
  AgentProfileArchiveInput,
  AgentProfileCatalogResult,
  AgentProfileId,
  AgentProfileInvalidError,
  AgentProfileNotFoundError,
  AgentProfileRef,
  AgentProfileRevision,
  AgentProfileRevisionConflictError,
  AgentRuleDocument,
  AgentRunId,
  AgentRunInvalidStateError,
  AgentRunListResult,
  AgentRunNotFoundError,
} from "./agents.ts";

const revision = AgentProfileRevision.make("a".repeat(64));
const decodeProfile = Schema.decodeUnknownSync(AgentProfile);
const decodeRule = Schema.decodeUnknownSync(AgentRuleDocument);
const decodeArchive = Schema.decodeUnknownSync(AgentProfileArchiveInput);
const decodeCatalog = Schema.decodeUnknownSync(AgentProfileCatalogResult);
const decodeSpawn = Schema.decodeUnknownSync(AgentMcpSpawnInput);
const decodeWait = Schema.decodeUnknownSync(AgentMcpWaitInput);
const decodeRunList = Schema.decodeUnknownSync(AgentRunListResult);
const decodeAgentProfileRef = Schema.decodeUnknownSync(AgentProfileRef);

const profile = {
  id: "reviewer",
  scope: "project",
  revision,
  name: " Reviewer ",
  description: " Reviews changes ",
  defaultModelSelection: { instanceId: "codex", model: " gpt-5.6 " },
  sourcePath: ".t3/agents/reviewer.md",
  requirements: { toolRequirement: "sandbox", t3McpCapabilities: ["filesystem"] },
  archivedAt: null,
  createdAt: "2026-08-07T00:00:00.000Z",
  updatedAt: "2026-08-07T00:00:00.000Z",
  instructions: " Review the change. ",
  instructionPriority: "system-required",
  runtime: { mode: "full-access", interactionMode: "default" },
  workspace: { mode: "isolated-worktree", access: "workspace-write" },
  tools: { policy: "allowlist", allowed: ["read", "git"] },
  delegation: { policy: "allowlist", profiles: [{ id: "implementer", scope: "environment" }] },
  budgets: { maxRuns: 4, maxConcurrency: 2, maxDepth: 2, maxWallTimeMinutes: 30 },
  hooks: [
    {
      stage: "promptBuild",
      kind: "context",
      path: ".t3/hooks/review-context.md",
      timeoutSeconds: 10,
      failurePolicy: "block",
    },
  ],
  rules: [{ id: "review-rules", path: " .t3/rules/review.md " }],
};

describe("native agent contracts", () => {
  it("decodes a decision-complete profile with unpinned policy locators", () => {
    const decoded = decodeProfile(profile);

    expect(decoded.name).toBe("Reviewer");
    expect(decoded.defaultModelSelection).toMatchObject({
      instanceId: "codex",
      model: "gpt-5.6",
    });
    expect(decoded.chatSelectable).toBe(true);
    expect(decoded.delegation.profiles).toEqual([{ id: "implementer", scope: "environment" }]);
    expect(decoded.rules).toEqual([{ id: "review-rules", path: ".t3/rules/review.md" }]);
  });

  it("defaults legacy profiles to chat-selectable and preserves an explicit delegation-only flag", () => {
    expect(decodeProfile(profile).chatSelectable).toBe(true);
    expect(decodeProfile({ ...profile, chatSelectable: false }).chatSelectable).toBe(false);
  });

  it("enforces depth, concurrency, run, wall-time, and hook-time ceilings", () => {
    expect(() =>
      decodeProfile({ ...profile, budgets: { ...profile.budgets, maxDepth: 5 } }),
    ).toThrow();
    expect(() =>
      decodeProfile({ ...profile, budgets: { ...profile.budgets, maxRuns: 33 } }),
    ).toThrow();
    expect(() =>
      decodeProfile({ ...profile, budgets: { ...profile.budgets, maxConcurrency: 9 } }),
    ).toThrow();
    expect(() =>
      decodeProfile({ ...profile, budgets: { ...profile.budgets, maxWallTimeMinutes: 121 } }),
    ).toThrow();
    expect(() =>
      decodeProfile({
        ...profile,
        hooks: [
          {
            stage: "promptBuild",
            kind: "context",
            path: ".t3/hooks/review-context.md",
            timeoutSeconds: 301,
            failurePolicy: "block",
          },
        ],
      }),
    ).toThrow();
  });

  it("uses locators to spawn and a generated UUID run id", () => {
    const decoded = decodeSpawn({
      profile: { id: "reviewer", scope: "project" },
      task: " Inspect the changes ",
      files: [" src/index.ts "],
      detached: true,
    });

    expect(decoded.profile).toEqual({ id: "reviewer", scope: "project" });
    expect(decoded.task).toBe("Inspect the changes");
    expect(decoded.files).toEqual(["src/index.ts"]);
    expect(AgentRunId.make("1f6d8404-3905-4f3a-b9f4-77d9e6b2d1ab")).toBe(
      "1f6d8404-3905-4f3a-b9f4-77d9e6b2d1ab",
    );
  });

  it("requires SHA revisions and bounds wait/result run sets", () => {
    expect(() => decodeArchive({ id: "reviewer", scope: "project" })).toThrow();
    expect(() =>
      decodeArchive({ id: "reviewer", scope: "project", expectedRevision: "A".repeat(64) }),
    ).toThrow();
    expect(() => decodeWait({ runIds: ["run"], timeoutSeconds: 56 })).toThrow();
    expect(() =>
      decodeRunList({
        runs: Array.from({ length: 33 }, () => ({
          id: "run",
          profile: { id: "reviewer", scope: "project", revision },
          status: "queued",
          revision: 0,
          childThreadId: null,
          parentRunId: null,
          startedAt: null,
          finishedAt: null,
          updatedAt: "2026-08-07T00:00:00.000Z",
        })),
      }),
    ).toThrow();
  });

  it("models rule targeting and source provenance", () => {
    const rule = decodeRule({
      id: "review-rules",
      scope: "project",
      revision,
      name: "Review rules",
      body: "Always inspect changed tests.",
      globs: ["src/**"],
      alwaysApply: false,
      priority: 50,
      profiles: [{ id: "reviewer", scope: "project" }],
      sourcePath: ".t3/rules/review.md",
      createdAt: "2026-08-07T00:00:00.000Z",
      updatedAt: "2026-08-07T00:00:00.000Z",
      archivedAt: null,
    });

    expect(rule.profiles).toEqual([{ id: "reviewer", scope: "project" }]);
    expect(() => decodeRule({ ...rule, priority: 101 })).toThrow();
  });

  it("transports bounded catalog diagnostics alongside valid entries", () => {
    const diagnostic = {
      code: "invalid-document",
      kind: "profile",
      scope: "project",
      id: "broken",
      sourcePath: ".t3/agents/broken.md",
      message: "The profile frontmatter is invalid.",
    } as const;

    expect(
      decodeCatalog({ profiles: [], rules: [], diagnostics: [diagnostic] }).diagnostics,
    ).toEqual([diagnostic]);
    expect(decodeCatalog({ profiles: [], rules: [] }).diagnostics).toEqual([]);
    expect(() =>
      decodeCatalog({
        profiles: [],
        rules: [],
        diagnostics: Array.from({ length: 101 }, () => ({ ...diagnostic })),
      }),
    ).toThrow();
  });

  it("keeps branded identifiers and pinned refs available to consumers", () => {
    expect(AgentProfileId.make("reviewer")).toBe("reviewer");
    expect(decodeAgentProfileRef({ id: "reviewer", scope: "environment", revision })).toEqual({
      id: "reviewer",
      scope: "environment",
      revision,
    });
  });

  it("provides actionable transport-safe messages for every Agent error", () => {
    expect(new AgentProfileInvalidError({ detail: "Delegation is not allowed." }).message).toBe(
      "Delegation is not allowed.",
    );
    expect(
      new AgentProfileNotFoundError({ id: AgentProfileId.make("missing"), scope: "project" })
        .message,
    ).toBe("Agent profile 'project/missing' was not found.");
    expect(
      new AgentProfileRevisionConflictError({
        id: AgentProfileId.make("reviewer"),
        scope: "environment",
        expectedRevision: AgentProfileRevision.make("a".repeat(64)),
        actualRevision: AgentProfileRevision.make("b".repeat(64)),
      }).message,
    ).toContain("changed from revision");
    expect(new AgentRunNotFoundError({ id: AgentRunId.make("missing-run") }).message).toBe(
      "Agent run 'missing-run' was not found.",
    );
    expect(
      new AgentRunInvalidStateError({
        id: AgentRunId.make("run"),
        status: "running",
        operation: "integrate",
      }).message,
    ).toBe("Agent run 'run' cannot perform 'integrate' while its status is 'running'.");
  });
});
