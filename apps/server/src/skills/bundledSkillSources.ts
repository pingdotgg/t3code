import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { ManagedSkill } from "@t3tools/contracts";

export type BundledSkillSource = Pick<
  ManagedSkill,
  "id" | "title" | "description" | "requirements"
> & {
  readonly files: Readonly<Record<string, string>>;
};

export const BUNDLED_SKILL_METADATA = [
  {
    id: "t3code-threads",
    title: "Threads & worktrees",
    description: "Create threads, send follow-ups, and hand off work in managed worktrees.",
    requirements: "Requires this agent's T3 Code MCP connection.",
  },
  {
    id: "t3code-orchestration",
    title: "Orchestration",
    description: "Coordinate background agents, parallel tasks, reviews, and their results.",
    requirements: "Requires this agent's T3 Code MCP connection and delegation access.",
  },
  {
    id: "t3code-browser",
    title: "Browser",
    description: "Browse, interact with pages, and verify requested flows in T3 Code's browser.",
    requirements: "Requires T3 Code browser tools and browser agent access on this environment.",
  },
  {
    id: "t3code-computer-use",
    title: "Computer use",
    description: "Operate native desktop apps using a controller connected to your agent.",
    requirements:
      "Requires external desktop-control tools on this provider. T3 Code does not include a desktop controller; installing this skill does not add one.",
  },
  {
    id: "t3code-linear",
    title: "Linear",
    description: "Read issues, scope implementation, and report verified PR results to Linear.",
    requirements:
      "Requires a Linear MCP connection configured and authenticated in this provider. Installing this skill does not connect your account.",
  },
  {
    id: "t3code-jira",
    title: "Jira",
    description: "Work from Jira issues and update them through valid workflow transitions.",
    requirements:
      "Requires a Jira MCP connection configured and authenticated in this provider. Installing this skill does not connect your account.",
  },
  {
    id: "t3code-ios",
    title: "iOS Simulator",
    description: "Build, install, and exercise iOS apps through T3 Code's Device panel.",
    requirements:
      "Requires device agent access and a compatible iOS host. Local simulators need macOS with Xcode and a simulator runtime.",
  },
  {
    id: "t3code-android",
    title: "Android devices",
    description: "Build, install, and exercise Android apps through T3 Code's Device panel.",
    requirements:
      "Requires device agent access, an Android SDK host and an emulator or connected device. Emulator video also needs ffmpeg with libx264.",
  },
  {
    id: "t3code-workspace-setup",
    title: "Worktree setup",
    description: "Configure reproducible worktree setup, dependencies, and isolated local state.",
    requirements:
      "Requires a configured project setup action (importable from t3.json). Disposable VM/cloud recipes from Orca are not supported.",
  },
] as const satisfies ReadonlyArray<Omit<BundledSkillSource, "files">>;

declare const __T3CODE_BUNDLED_SKILLS__: ReadonlyArray<BundledSkillSource> | undefined;

export const loadBundledSkillSources = Effect.fn("loadBundledSkillSources")(function* () {
  if (typeof __T3CODE_BUNDLED_SKILLS__ !== "undefined") return __T3CODE_BUNDLED_SKILLS__;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* Effect.forEach(BUNDLED_SKILL_METADATA, (skill) =>
    Effect.gen(function* () {
      const root = path.resolve(import.meta.dirname, "../../../../.agents/skills", skill.id);
      const entries = yield* Effect.forEach(["SKILL.md", "LICENSE"], (name) =>
        fs.readFileString(path.join(root, name)).pipe(Effect.map((text) => [name, text] as const)),
      );
      return { ...skill, files: Object.fromEntries(entries) };
    }),
  );
});
