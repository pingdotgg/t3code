/**
 * WorkspaceAgentSkills - Effect service for per-project skill discovery.
 *
 * Resolves project-scoped skills (`<root>/.agents/skills`, plus Claude's
 * `<root>/.claude/skills`) for a specific workspace root and provider, so a
 * project's skills follow the project rather than the server's launch
 * directory. User-scoped skills still travel on the environment-level provider
 * snapshot; this service supplies only the project-scoped half.
 *
 * @module WorkspaceAgentSkills
 */
import type { ProjectListAgentSkillsInput, ProjectListAgentSkillsResult } from "@t3tools/contracts";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { discoverProjectAgentSkills } from "../provider/Drivers/AgentSkills.ts";
import { discoverClaudeProjectSkills } from "../provider/Drivers/ClaudeSkills.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

// Claude layers vendor-specific project skills (`<root>/.claude/skills`) on top
// of the portable `<root>/.agents/skills`; every other driver is portable-only.
const CLAUDE_DRIVER_KIND = ProviderDriverKind.make("claudeAgent");

/** Service tag for per-project skill discovery. */
export class WorkspaceAgentSkills extends Context.Service<
  WorkspaceAgentSkills,
  {
    readonly list: (
      input: ProjectListAgentSkillsInput,
    ) => Effect.Effect<
      ProjectListAgentSkillsResult,
      WorkspacePaths.WorkspacePathsError,
      FileSystem.FileSystem | Path.Path
    >;
  }
>()("t3/workspace/WorkspaceAgentSkills") {}

export const make = Effect.gen(function* () {
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;

  const list: WorkspaceAgentSkills["Service"]["list"] = Effect.fn("WorkspaceAgentSkills.list")(
    function* (input) {
      const root = yield* workspacePaths.normalizeWorkspaceRoot(input.cwd);
      const skills = yield* input.provider === CLAUDE_DRIVER_KIND
        ? discoverClaudeProjectSkills(root)
        : discoverProjectAgentSkills(root);
      return { skills };
    },
  );

  return WorkspaceAgentSkills.of({ list });
});

export const layer = Layer.effect(WorkspaceAgentSkills, make);
