import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  discoverCopilotSkills,
  hasCopilotSkillMention,
  isCopilotAcpSettings,
  rewriteCopilotSkillMentions,
} from "./copilotSkills.ts";

describe("Copilot skills", () => {
  it.effect("discovers personal, plugin, and project skills, with the project copy winning", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDirectory = (prefix: string) =>
        fileSystem
          .makeTempDirectoryScoped({ directory: NodeOS.tmpdir(), prefix })
          .pipe(Effect.flatMap((directory) => fileSystem.realPath(directory)));
      const home = yield* tempDirectory("copilot-skills-home-");
      const workspace = yield* tempDirectory("copilot-skills-workspace-");
      const writeSkill = (directory: string, contents: string) =>
        Effect.gen(function* () {
          yield* fileSystem.makeDirectory(directory, { recursive: true });
          yield* fileSystem.writeFileString(path.join(directory, "SKILL.md"), contents);
        });

      yield* writeSkill(
        path.join(home, ".agents", "skills", "personal"),
        "---\nname: personal\ndescription: Personal skill\n---\n",
      );
      yield* writeSkill(
        path.join(home, ".agents", "skills", "shared"),
        "---\ndescription: Personal shared\n---\n",
      );
      yield* writeSkill(
        path.join(workspace, ".github", "skills", "shared"),
        "---\ndescription: Project shared\n---\n",
      );
      yield* writeSkill(
        path.join(workspace, ".agents", "skills", "folder-name"),
        "---\nname: renamed\ndescription: Renamed skill\n---\n",
      );
      yield* writeSkill(
        path.join(workspace, ".agents", "skills", "large-folder"),
        `---\nname: large-renamed\ndescription: Large skill\n---\n${"body\n".repeat(8_000)}`,
      );
      yield* writeSkill(
        path.join(home, ".copilot", "installed-plugins", "acme", "skills", "plugin-skill"),
        "---\ndescription: Plugin skill\n---\n",
      );
      yield* fileSystem.makeDirectory(path.join(workspace, ".claude", "skills", "not-a-skill"), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(
        path.join(workspace, ".claude", "skills", "not-a-skill", "README.md"),
        "no skill",
      );

      const skills = yield* discoverCopilotSkills(workspace, { HOME: home });
      const byName = new Map(skills.map((skill) => [skill.name, skill]));
      expect(byName.get("personal")).toMatchObject({
        path: path.join(home, ".agents", "skills", "personal", "SKILL.md"),
        scope: "user",
        description: "Personal skill",
        enabled: true,
      });
      expect(byName.get("shared")).toMatchObject({
        path: path.join(workspace, ".github", "skills", "shared", "SKILL.md"),
        scope: "project",
        description: "Project shared",
      });
      expect(byName.get("renamed")).toMatchObject({
        path: path.join(workspace, ".agents", "skills", "folder-name", "SKILL.md"),
        scope: "project",
      });
      expect(byName.get("folder-name")).toBeUndefined();
      expect(byName.get("large-renamed")).toMatchObject({ description: "Large skill" });
      expect(byName.has("large-folder")).toBe(false);
      expect(byName.get("plugin-skill")).toMatchObject({
        path: path.join(
          home,
          ".copilot",
          "installed-plugins",
          "acme",
          "skills",
          "plugin-skill",
          "SKILL.md",
        ),
        scope: "user",
      });
      expect(byName.has("not-a-skill")).toBe(false);
      expect(byName.has("skills")).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("scans project roots even when a personal root exhausts its entry budget", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "copilot-skills-home-" });
      const workspace = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "copilot-skills-workspace-",
      });
      const crowded = path.join(home, ".copilot", "installed-plugins", "crowded");
      yield* fileSystem.makeDirectory(crowded, { recursive: true });
      yield* Effect.forEach(
        Array.from({ length: 4_001 }, (_, index) => path.join(crowded, `file-${index}`)),
        (file) => fileSystem.writeFileString(file, ""),
        { concurrency: 64, discard: true },
      );
      const projectSkill = path.join(workspace, ".github", "skills", "project-only");
      yield* fileSystem.makeDirectory(projectSkill, { recursive: true });
      yield* fileSystem.writeFileString(path.join(projectSkill, "SKILL.md"), "---\n---\n");

      const skills = yield* discoverCopilotSkills(workspace, { HOME: home });
      expect(skills.map((skill) => skill.name)).toContain("project-only");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it("rewrites discovered skill mentions into Copilot slash commands", () => {
    const names = new Set(["review"]);
    expect(rewriteCopilotSkillMentions("$review this", names)).toBe("/review this");
    expect(rewriteCopilotSkillMentions("use $review and keep $HOME", names)).toBe(
      "use /review and keep $HOME",
    );
    expect(rewriteCopilotSkillMentions("$unknown", names)).toBe("$unknown");
    expect(rewriteCopilotSkillMentions("$review", new Set(["Review"]))).toBe("/review");
    expect(hasCopilotSkillMention("$5 later")).toBe(false);
    expect(hasCopilotSkillMention("run $review")).toBe(true);
  });

  it.each([
    [{ source: "registry" as const, agentId: "github-copilot-cli", commandPath: "" }, true],
    [{ source: "local" as const, agentId: "", commandPath: "/usr/bin/copilot" }, true],
    [{ source: "local" as const, agentId: "github-copilot-cli", commandPath: "claude" }, false],
    [{ source: "registry" as const, agentId: "devin", commandPath: "copilot" }, false],
  ])("recognizes Copilot settings %j", (settings, expected) => {
    expect(isCopilotAcpSettings(settings)).toBe(expected);
  });
});
