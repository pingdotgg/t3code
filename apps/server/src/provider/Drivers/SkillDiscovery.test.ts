import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  discoverSkillsFromRoots,
  listAncestorPaths,
  parseSkillFrontmatter,
  resolveGitRootPath,
} from "./SkillDiscovery.ts";

it.layer(NodeServices.layer)("parseSkillFrontmatter", (it) => {
  it("parses name and description", () => {
    const result = parseSkillFrontmatter(
      "---\nname: deploy\ndescription: Deploy the app.\n---\n# Body\n",
    );
    assert.deepEqual(result, {
      kind: "parsed",
      name: "deploy",
      description: "Deploy the app.",
    });
  });

  it("returns malformed for broken yaml", () => {
    const result = parseSkillFrontmatter("---\nname: [unclosed\n---\n");
    assert.equal(result.kind, "malformed");
  });

  it("returns missing when frontmatter is absent", () => {
    const result = parseSkillFrontmatter("# Just a heading\n");
    assert.equal(result.kind, "missing");
  });
});

it.layer(NodeServices.layer)("discoverSkillsFromRoots", (it) => {
  it.effect("later roots override earlier roots on name collision", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skill-discovery-" });
      const userDir = path.join(tempDir, "user", "skills");
      const projectDir = path.join(tempDir, "project", "skills");

      for (const [dir, description] of [
        [userDir, "User deploy."],
        [projectDir, "Project deploy."],
      ] as const) {
        const skillDir = path.join(dir, "deploy");
        yield* fs.makeDirectory(skillDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(skillDir, "SKILL.md"),
          `---\nname: deploy\ndescription: ${description}\n---\n`,
        );
      }

      const skills = yield* discoverSkillsFromRoots([
        { directory: userDir, scope: "user" },
        { directory: projectDir, scope: "project" },
      ]);

      assert.equal(skills.length, 1);
      assert.equal(skills[0]?.scope, "project");
      assert.equal(skills[0]?.description, "Project deploy.");
    }),
  );
});

it.layer(NodeServices.layer)("resolveGitRootPath", (it) => {
  it.effect("finds .git walking up from nested dir", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skill-gitroot-" });
      const repo = path.join(tempDir, "repo");
      const nested = path.join(repo, "a", "b");
      yield* fs.makeDirectory(path.join(repo, ".git"), { recursive: true });
      yield* fs.makeDirectory(nested, { recursive: true });

      const root = yield* resolveGitRootPath(nested);
      assert.equal(path.resolve(root), path.resolve(repo));
    }),
  );
});

it.layer(NodeServices.layer)("listAncestorPaths", (it) => {
  it.effect("returns git root first and cwd last", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skill-ancestors-" });
      const repo = path.join(tempDir, "repo");
      const mid = path.join(repo, "packages", "foo");
      const nested = path.join(mid, "apps", "web");
      yield* fs.makeDirectory(path.join(repo, ".git"), { recursive: true });
      yield* fs.makeDirectory(nested, { recursive: true });

      const ancestors = listAncestorPaths(path, nested, repo).map((entry) => path.resolve(entry));
      assert.equal(ancestors[0], path.resolve(repo));
      assert.equal(ancestors.at(-1), path.resolve(nested));
      assert.ok(ancestors.includes(path.resolve(mid)));
      assert.ok(ancestors.length >= 3);
    }),
  );
});
