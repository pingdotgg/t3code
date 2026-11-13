import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverKiroSkills } from "./skills.ts";

describe("discoverKiroSkills", () => {
  // Each case is what a kiro-cli 3.1.0 session advertised in
  // `available_commands_update` for the same folders.
  it.effect("lists the user and workspace skills a Kiro session loads", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-kiro-skills-home-" });
      const repo = path.join(home, "repo");
      const workspace = path.join(repo, "packages", "app");
      const userRoot = path.join(home, ".kiro", "skills");
      const workspaceRoot = path.join(workspace, ".kiro", "skills");
      const write = (root: string, folder: string, contents: string) =>
        fileSystem
          .makeDirectory(path.join(root, folder), { recursive: true })
          .pipe(
            Effect.andThen(
              fileSystem.writeFileString(path.join(root, folder, "SKILL.md"), contents),
            ),
          );
      const skill = (name: string, description: string) =>
        `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`;

      yield* write(userRoot, "shared", skill("shared", "user copy"));
      yield* write(userRoot, "user-only", skill("user-only", "from the home folder"));
      yield* write(workspaceRoot, "block", "---\nname: block\ndescription: >\n  one\n  two\n---\n");
      yield* write(workspaceRoot, "crlf", "---\r\nname: crlf\r\ndescription: windows\r\n---\r\n");
      yield* write(workspaceRoot, "folder-a", skill("renamed", "named by its front matter"));
      yield* write(workspaceRoot, "open", "---\nname: open\ndescription: no closing fence\n");
      yield* write(workspaceRoot, "shared", skill("shared", "workspace copy"));
      // Kiro loads none of these.
      yield* write(workspaceRoot, "bad-yaml", "---\nname: bad-yaml\ndescription: [unclosed\n---\n");
      yield* write(workspaceRoot, "capitals", skill("Capitals", "invalid name"));
      yield* write(workspaceRoot, "long-name", skill("a".repeat(65), "name over 64 characters"));
      yield* write(workspaceRoot, "no-description", "---\nname: no-description\n---\n");
      yield* write(workspaceRoot, "no-frontmatter", "Just a body.\n");
      yield* write(workspaceRoot, "numeric", skill("123", "YAML reads the name as a number"));
      yield* write(workspaceRoot, "snake", skill("snake_case", "invalid name"));
      yield* write(workspaceRoot, "wordy", skill("wordy", "x".repeat(1_025)));
      yield* write(path.join(workspaceRoot, "group"), "nested", skill("nested", "too deep"));
      yield* write(path.join(repo, ".kiro", "skills"), "parent", skill("parent", "above cwd"));
      yield* fileSystem.writeFileString(path.join(workspaceRoot, "loose.md"), skill("loose", "x"));

      const skills = yield* discoverKiroSkills({ cwd: workspace, environment: { HOME: home } });

      assert.deepEqual(
        skills.map(({ name, description, scope }) => ({ name, description, scope })),
        [
          { name: "shared", description: "workspace copy", scope: "project" },
          { name: "user-only", description: "from the home folder", scope: "user" },
          { name: "block", description: "one two", scope: "project" },
          { name: "crlf", description: "windows", scope: "project" },
          { name: "renamed", description: "named by its front matter", scope: "project" },
          { name: "open", description: "no closing fence", scope: "project" },
        ],
      );
      assert.equal(skills[0]?.path, path.join(workspaceRoot, "shared", "SKILL.md"));
      assert.isTrue(skills.every((entry) => entry.enabled));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
