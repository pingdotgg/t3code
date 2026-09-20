import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { PersistenceSqlError } from "../persistence/Errors.ts";
import type { ServerSettingsService } from "../serverSettings.ts";
import type * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { makeSourceControlWritingPolicyResolver } from "../textGeneration/SourceControlWriting.ts";
import { makeSourceControlPanelReaders } from "./SourceControlPanelReaders.ts";

const textGenerationModelSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "text-generation-model",
  options: [],
};
const sourceControlWriterModelSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "source-control-writer-model",
  options: [],
};

function makeReaders(input: {
  readonly sourceControlWriterModelSelection: ModelSelection | null;
  readonly sourceControlWritingStyle: typeof DEFAULT_SERVER_SETTINGS.sourceControlWritingStyle;
  readonly onGenerate: (request: TextGeneration.CommitMessageGenerationInput) => void;
  readonly recentCommitSubjects?: readonly string[];
  readonly repositoryInstructions?: Readonly<Partial<Record<"AGENTS.md" | "CLAUDE.md", string>>>;
  readonly providers?: ReadonlyArray<ServerProvider>;
  readonly projectSettingsOverrides?: typeof DEFAULT_SERVER_SETTINGS.projectSettingsOverrides;
  readonly projects?: Readonly<Record<string, ProjectId>>;
  readonly workspaceRoot?: string;
  readonly mainWorkspaceRoot?: string;
  readonly failProjectLookup?: boolean;
}) {
  const settings = {
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: {
      ...DEFAULT_SERVER_SETTINGS.providerInstances,
      ...Object.fromEntries(
        (input.providers ?? []).map((provider) => [
          provider.instanceId,
          { driver: provider.driver, config: {} },
        ]),
      ),
    },
    textGenerationModelSelection,
    projectSettingsOverrides: input.projectSettingsOverrides ?? {},
    sourceControlWriterModelSelection: input.sourceControlWriterModelSelection,
    sourceControlWritingStyle: input.sourceControlWritingStyle,
  };
  const providers =
    input.providers ??
    (input.sourceControlWriterModelSelection
      ? [
          {
            instanceId: input.sourceControlWriterModelSelection.instanceId,
            driver:
              input.sourceControlWriterModelSelection.instanceId === "claudeAgent"
                ? ProviderDriverKind.make("claudeAgent")
                : ProviderDriverKind.make("codex"),
            enabled: true,
            installed: true,
            version: "1.0.0",
            status: "ready",
            auth: { status: "authenticated" },
            checkedAt: "2026-09-01T00:00:00.000Z",
            models: [],
            slashCommands: [],
            skills: [],
          } satisfies ServerProvider,
        ]
      : []);
  return makeSourceControlPanelReaders({
    projectIdForWorkspace: (cwd) =>
      input.failProjectLookup
        ? Effect.fail(new PersistenceSqlError({ operation: "test.projectLookup" }))
        : Effect.succeed(input.projects?.[cwd] ?? null),
    run: (operation) =>
      Effect.succeed(
        operation === "vcs.panel.writingWorkspaceRoot"
          ? (input.workspaceRoot ?? "/repo")
          : operation === "vcs.panel.writingWorktrees"
            ? `worktree ${input.mainWorkspaceRoot ?? "/repo"}\0detached\0\0`
            : operation.endsWith("Summary")
              ? "1 file changed"
              : operation.endsWith("Status")
                ? "M src/example.ts"
                : "diff --git a/src/example.ts b/src/example.ts",
      ),
    serverSettings: {
      getSettings: Effect.succeed(settings),
    } as unknown as ServerSettingsService["Service"],
    sourceControlProviders: undefined,
    sourceControlRateLimits: undefined,
    getProviders: Effect.succeed(providers),
    resolveWritingPolicy: makeSourceControlWritingPolicyResolver({
      runGit: () => Effect.succeed((input.recentCommitSubjects ?? []).join("\n")),
      readRepositoryInstructions: (_cwd, fileName) =>
        Effect.succeed(input.repositoryInstructions?.[fileName as "AGENTS.md" | "CLAUDE.md"] ?? ""),
    }),
    textGeneration: {
      generateCommitMessage: (request: TextGeneration.CommitMessageGenerationInput) =>
        Effect.sync(() => {
          input.onGenerate(request);
          return { subject: "Generated message", body: "" };
        }),
    } as unknown as TextGeneration.TextGeneration["Service"],
  });
}

describe("SourceControlPanelReaders generated messages", () => {
  it.effect("uses registered checkout overrides for commits and stashes", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project");
      const requests: TextGeneration.CommitMessageGenerationInput[] = [];
      const projectWriter = { ...sourceControlWriterModelSelection, model: "project-writer" };
      const readers = makeReaders({
        sourceControlWriterModelSelection,
        sourceControlWritingStyle: {
          mode: "custom",
          customInstructions: "Environment style",
          followChangeRequestTemplates: true,
        },
        projectSettingsOverrides: {
          [projectId]: {
            sourceControlWriterModelSelection: projectWriter,
            sourceControlWritingStyle: {
              mode: "custom",
              customInstructions: "Project style",
              followChangeRequestTemplates: true,
            },
          },
        },
        projects: { "/repo": projectId },
        onGenerate: (request) => requests.push(request),
      });
      yield* readers.generatedCommitMessage("/repo");
      yield* readers.generatedStashMessage("/repo", "all");
      assert.equal(requests.length, 2);
      for (const request of requests) {
        assert.deepStrictEqual(request.modelSelection, projectWriter);
        assert.equal(request.policy?.commitInstructions, "Project style");
      }
    }),
  );

  it.effect("prefers registered sibling overrides from a nested cwd over the main project", () =>
    Effect.gen(function* () {
      const siblingId = ProjectId.make("sibling-project");
      const mainId = ProjectId.make("main-project");
      const requests: TextGeneration.CommitMessageGenerationInput[] = [];
      const siblingWriter = { ...sourceControlWriterModelSelection, model: "sibling-writer" };
      const readers = makeReaders({
        sourceControlWriterModelSelection,
        sourceControlWritingStyle: DEFAULT_SERVER_SETTINGS.sourceControlWritingStyle,
        projectSettingsOverrides: {
          [siblingId]: {
            sourceControlWriterModelSelection: siblingWriter,
            sourceControlWritingStyle: {
              mode: "custom",
              customInstructions: "Sibling style",
              followChangeRequestTemplates: true,
            },
          },
          [mainId]: {
            sourceControlWriterModelSelection: {
              ...sourceControlWriterModelSelection,
              model: "main-writer",
            },
            sourceControlWritingStyle: {
              mode: "custom",
              customInstructions: "Main style",
              followChangeRequestTemplates: true,
            },
          },
        },
        projects: { "/sibling": siblingId, "/repo": mainId },
        workspaceRoot: "/sibling",
        mainWorkspaceRoot: "/repo",
        onGenerate: (request) => requests.push(request),
      });
      yield* readers.generatedCommitMessage("/sibling/sub");
      yield* readers.generatedStashMessage("/sibling/sub", "all");
      assert.equal(requests.length, 2);
      for (const request of requests) {
        assert.deepStrictEqual(request.modelSelection, siblingWriter);
        assert.equal(request.policy?.commitInstructions, "Sibling style");
      }
    }),
  );

  it.effect("inherits main-project overrides for unregistered sibling worktrees", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("main-project");
      let request: TextGeneration.CommitMessageGenerationInput | undefined;
      const projectTextWriter = { ...textGenerationModelSelection, model: "project-text-writer" };
      const readers = makeReaders({
        sourceControlWriterModelSelection,
        sourceControlWritingStyle: {
          mode: "custom",
          customInstructions: "Environment style",
          followChangeRequestTemplates: true,
        },
        projectSettingsOverrides: {
          [projectId]: {
            sourceControlWriterModelSelection: null,
            textGenerationModelSelection: projectTextWriter,
            sourceControlWritingStyle: {
              mode: "custom",
              customInstructions: "Main project style",
              followChangeRequestTemplates: true,
            },
          },
        },
        projects: { "/repo": projectId },
        workspaceRoot: "/sibling",
        mainWorkspaceRoot: "/repo",
        onGenerate: (value) => {
          request = value;
        },
      });
      yield* readers.generatedStashMessage("/sibling", "all");
      assert.deepStrictEqual(request?.modelSelection, projectTextWriter);
      assert.equal(request?.policy?.commitInstructions, "Main project style");
    }),
  );

  it.effect("keeps environment generation when project lookup fails", () =>
    Effect.gen(function* () {
      let request: TextGeneration.CommitMessageGenerationInput | undefined;
      const readers = makeReaders({
        sourceControlWriterModelSelection,
        sourceControlWritingStyle: {
          mode: "custom",
          customInstructions: "Environment style",
          followChangeRequestTemplates: true,
        },
        projectSettingsOverrides: {
          [ProjectId.make("unrelated")]: { sourceControlWriterModelSelection: null },
        },
        failProjectLookup: true,
        onGenerate: (value) => {
          request = value;
        },
      });
      assert.equal(yield* readers.generatedCommitMessage("/repo"), "Generated message");
      assert.deepStrictEqual(request?.modelSelection, sourceControlWriterModelSelection);
      assert.equal(request?.policy?.commitInstructions, "Environment style");
    }),
  );

  it.effect("uses the source control writer model and writing style for commits", () =>
    Effect.gen(function* () {
      let generatedInput: TextGeneration.CommitMessageGenerationInput | undefined;
      const readers = makeReaders({
        sourceControlWriterModelSelection,
        sourceControlWritingStyle: {
          mode: "custom",
          customInstructions: "Use the configured source control voice.",
          followChangeRequestTemplates: true,
        },
        onGenerate: (request) => {
          generatedInput = request;
        },
      });

      assert.equal(yield* readers.generatedCommitMessage("/repo"), "Generated message");
      assert.deepStrictEqual(generatedInput?.modelSelection, sourceControlWriterModelSelection);
      assert.deepInclude(generatedInput?.policy, {
        kind: "custom",
        commitInstructions: "Use the configured source control voice.",
        inferRepositoryConventions: false,
      });
    }),
  );

  it.effect("falls back to the text generation model and keeps writing style for stashes", () =>
    Effect.gen(function* () {
      let generatedInput: TextGeneration.CommitMessageGenerationInput | undefined;
      const readers = makeReaders({
        sourceControlWriterModelSelection: null,
        sourceControlWritingStyle: {
          mode: "conventional_commits",
          customInstructions: "",
          followChangeRequestTemplates: true,
        },
        onGenerate: (request) => {
          generatedInput = request;
        },
      });

      assert.equal(yield* readers.generatedStashMessage("/repo", "all"), "Generated message");
      assert.deepStrictEqual(generatedInput?.modelSelection, textGenerationModelSelection);
      assert.equal(generatedInput?.policy?.kind, "conventional_commits");
    }),
  );

  it.effect("uses repository instructions for panel commits and stashes", () =>
    Effect.gen(function* () {
      const generatedPolicies: TextGeneration.CommitMessageGenerationInput["policy"][] = [];
      const agentInstructions = "Use lowercase source control text.";
      const claudeInstructions = "Keep generated messages brief.";
      const readers = makeReaders({
        sourceControlWriterModelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-sonnet-4-6",
          options: [],
        },
        sourceControlWritingStyle: {
          mode: "repo_conventions",
          customInstructions: "",
          followChangeRequestTemplates: true,
        },
        recentCommitSubjects: ["feat: keep the existing subject style"],
        repositoryInstructions: {
          "AGENTS.md": agentInstructions,
          "CLAUDE.md": claudeInstructions,
        },
        onGenerate: (request) => {
          generatedPolicies.push(request.policy);
        },
      });

      assert.equal(yield* readers.generatedCommitMessage("/repo"), "Generated message");
      assert.equal(yield* readers.generatedStashMessage("/repo", "all"), "Generated message");

      const repositoryContext = [
        "Recent commit subjects from this repository:\nfeat: keep the existing subject style",
        `Local AGENTS.md:\n${agentInstructions}`,
        `Local CLAUDE.md:\n${claudeInstructions}`,
      ].join("\n\n");
      const expectedPolicy: NonNullable<TextGeneration.CommitMessageGenerationInput["policy"]> = {
        kind: "repo_conventions",
        commitInstructions: `Follow the repository's established commit message style when examples are available.\n\n${repositoryContext}`,
        changeRequestInstructions: `Follow the repository's established change request title and body style when examples are available.\n\n${repositoryContext}`,
        inferRepositoryConventions: true,
      };
      assert.deepStrictEqual(generatedPolicies, [expectedPolicy, expectedPolicy]);
    }),
  );

  it.effect("excludes Claude instructions for non-Claude panel writers", () =>
    Effect.gen(function* () {
      let generatedPolicy: TextGeneration.CommitMessageGenerationInput["policy"];
      const readers = makeReaders({
        sourceControlWriterModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
          options: [],
        },
        sourceControlWritingStyle: {
          mode: "repo_conventions",
          customInstructions: "",
          followChangeRequestTemplates: true,
        },
        repositoryInstructions: {
          "AGENTS.md": "Use repository commit conventions.",
          "CLAUDE.md": "Only Claude writers should receive this.",
        },
        onGenerate: (request) => {
          generatedPolicy = request.policy;
        },
      });

      assert.equal(yield* readers.generatedCommitMessage("/repo"), "Generated message");
      assert.match(generatedPolicy?.commitInstructions ?? "", /Local AGENTS\.md:/);
      assert.equal((generatedPolicy?.commitInstructions ?? "").includes("Local CLAUDE.md:"), false);
    }),
  );

  it.effect("uses Claude instructions for custom Claude provider instances", () =>
    Effect.gen(function* () {
      let generatedPolicy: TextGeneration.CommitMessageGenerationInput["policy"];
      const customClaudeInstanceId = ProviderInstanceId.make("claude-secondary");
      const readers = makeReaders({
        sourceControlWriterModelSelection: {
          instanceId: customClaudeInstanceId,
          model: "claude-sonnet-4-6",
          options: [],
        },
        sourceControlWritingStyle: {
          mode: "repo_conventions",
          customInstructions: "",
          followChangeRequestTemplates: true,
        },
        providers: [
          {
            instanceId: customClaudeInstanceId,
            driver: ProviderDriverKind.make("claudeAgent"),
            enabled: true,
            installed: true,
            version: "1.0.0",
            status: "ready",
            auth: { status: "authenticated" },
            checkedAt: "2026-09-01T00:00:00.000Z",
            models: [],
            slashCommands: [],
            skills: [],
          },
        ],
        repositoryInstructions: {
          "AGENTS.md": "Use repository commit conventions.",
          "CLAUDE.md": "Keep custom Claude messages brief.",
        },
        onGenerate: (request) => {
          generatedPolicy = request.policy;
        },
      });

      assert.equal(yield* readers.generatedCommitMessage("/repo"), "Generated message");
      assert.match(generatedPolicy?.commitInstructions ?? "", /Local CLAUDE\.md:/);
    }),
  );

  it.effect("falls back from unavailable source control writers before resolving policy", () =>
    Effect.gen(function* () {
      let generatedInput: TextGeneration.CommitMessageGenerationInput | undefined;
      const unavailableInstanceId = ProviderInstanceId.make("claude-unavailable");
      const readers = makeReaders({
        sourceControlWriterModelSelection: {
          instanceId: unavailableInstanceId,
          model: "claude-sonnet-4-6",
          options: [],
        },
        sourceControlWritingStyle: {
          mode: "repo_conventions",
          customInstructions: "",
          followChangeRequestTemplates: true,
        },
        providers: [
          {
            instanceId: unavailableInstanceId,
            driver: ProviderDriverKind.make("claudeAgent"),
            enabled: false,
            installed: false,
            version: null,
            status: "disabled",
            auth: { status: "unknown" },
            checkedAt: "2026-09-01T00:00:00.000Z",
            availability: "unavailable",
            unavailableReason: "Claude is not available in this test.",
            models: [],
            slashCommands: [],
            skills: [],
          },
        ],
        repositoryInstructions: {
          "AGENTS.md": "Use repository commit conventions.",
          "CLAUDE.md": "Unavailable Claude writers must not receive this.",
        },
        onGenerate: (request) => {
          generatedInput = request;
        },
      });

      assert.equal(yield* readers.generatedCommitMessage("/repo"), "Generated message");
      assert.deepStrictEqual(generatedInput?.modelSelection, textGenerationModelSelection);
      assert.equal(
        (generatedInput?.policy?.commitInstructions ?? "").includes("Local CLAUDE.md:"),
        false,
      );
    }),
  );
});
