import * as ByteSize from "effect/ByteSize";
import type {
  ModelSelection,
  ServerProvider,
  SourceControlWritingStyleSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

import type { TextGenerationPolicy } from "./TextGenerationPolicy.ts";
import {
  conventionalCommitsTextGenerationPolicy,
  customTextGenerationPolicy,
  repositoryConventionsTextGenerationPolicy,
} from "./TextGenerationPresets.ts";

export interface SourceControlTextGenerationSettings {
  readonly modelSelection: ModelSelection;
  readonly providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "driver">>;
  readonly style: SourceControlWritingStyleSettings;
}

export type SourceControlWritingPolicyResolver = (
  cwd: string,
  settings: SourceControlTextGenerationSettings,
) => Effect.Effect<TextGenerationPolicy>;

export function makeSourceControlRepositoryInstructionReader(
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
) {
  return Effect.fn("readSourceControlRepositoryInstructions")(
    function* (cwd: string, fileName: string) {
      const root = yield* fileSystem.realPath(cwd);
      const instructionPath = yield* fileSystem.realPath(path.join(root, fileName));
      if (!instructionPath.startsWith(`${root}${path.sep}`)) return "";
      const info = yield* fileSystem.stat(instructionPath);
      if (info.type !== "File" || info.size > ByteSize.bytes(20_000)) return "";
      return (yield* fileSystem.readFileString(instructionPath)).trim();
    },
    Effect.orElseSucceed(() => ""),
  );
}

export function makeSourceControlWritingPolicyResolver<RunGitError>(dependencies: {
  readonly runGit: (cwd: string, args: readonly string[]) => Effect.Effect<string, RunGitError>;
  readonly readRepositoryInstructions: (cwd: string, fileName: string) => Effect.Effect<string>;
}): SourceControlWritingPolicyResolver {
  const readRecentCommitSubjects = (cwd: string) =>
    dependencies.runGit(cwd, ["log", "-n", "20", "--no-merges", "--pretty=format:%s"]).pipe(
      Effect.map((output) =>
        output
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0),
      ),
      Effect.orElseSucceed(() => []),
    );

  return Effect.fn("resolveSourceControlWritingPolicyForRepository")(function* (
    cwd: string,
    settings: SourceControlTextGenerationSettings,
  ) {
    if (settings.style.mode !== "repo_conventions") {
      return resolveSourceControlWritingPolicy(settings.style);
    }

    const [recentCommitSubjects, agentInstructions] = yield* Effect.all(
      [readRecentCommitSubjects(cwd), dependencies.readRepositoryInstructions(cwd, "AGENTS.md")],
      { concurrency: "unbounded" },
    );
    const isClaudeWriter =
      settings.modelSelection.instanceId === "claudeAgent" ||
      settings.providers.some(
        (provider) =>
          provider.instanceId === settings.modelSelection.instanceId &&
          provider.driver === "claudeAgent",
      );
    const claudeInstructions = isClaudeWriter
      ? yield* dependencies.readRepositoryInstructions(cwd, "CLAUDE.md")
      : "";

    return resolveSourceControlWritingPolicy(settings.style, recentCommitSubjects, [
      ...(agentInstructions ? [`Local AGENTS.md:\n${agentInstructions}`] : []),
      ...(claudeInstructions ? [`Local CLAUDE.md:\n${claudeInstructions}`] : []),
    ]);
  });
}

function resolveSourceControlWritingPolicy(
  style: SourceControlWritingStyleSettings,
  recentCommitSubjects: readonly string[] = [],
  repositoryInstructionSections: readonly string[] = [],
): TextGenerationPolicy {
  switch (style.mode) {
    case "conventional_commits":
      return conventionalCommitsTextGenerationPolicy;
    case "custom":
      return customTextGenerationPolicy(
        style.customInstructions
          ? {
              commitInstructions: style.customInstructions,
              changeRequestInstructions: style.customInstructions,
            }
          : {},
      );
    case "repo_conventions": {
      const examples = [
        ...(recentCommitSubjects.length > 0
          ? [["Recent commit subjects from this repository:", ...recentCommitSubjects].join("\n")]
          : []),
        ...repositoryInstructionSections,
      ].join("\n\n");
      if (!examples) {
        return repositoryConventionsTextGenerationPolicy;
      }
      return {
        ...repositoryConventionsTextGenerationPolicy,
        commitInstructions: `${repositoryConventionsTextGenerationPolicy.commitInstructions}\n\n${examples}`,
        changeRequestInstructions: `${repositoryConventionsTextGenerationPolicy.changeRequestInstructions}\n\n${examples}`,
      };
    }
  }
}
