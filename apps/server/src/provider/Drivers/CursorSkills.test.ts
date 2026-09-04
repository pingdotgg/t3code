import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";

import {
  discoverCursorSkills,
  hasCursorSkillMention,
  probeCursorSkills,
  rewriteCursorSkillMentions,
} from "./CursorSkills.ts";

const runNode = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
) => effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise);

describe("Cursor skills", () => {
  it("discovers recursive project skills with project precedence", async () =>
    await runNode(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const userHome = yield* fileSystem
          .makeTempDirectoryScoped({
            directory: NodeOS.tmpdir(),
            prefix: "cursor-skills-home-",
          })
          .pipe(Effect.flatMap((directory) => fileSystem.realPath(directory)));
        const workspace = yield* fileSystem
          .makeTempDirectoryScoped({
            directory: NodeOS.tmpdir(),
            prefix: "cursor-skills-workspace-",
          })
          .pipe(Effect.flatMap((directory) => fileSystem.realPath(directory)));
        const writeSkill = Effect.fn("writeCursorSkill")(function* (
          root: string,
          name: string,
          contents: string,
        ) {
          const skillDirectory = path.join(root, name);
          yield* fileSystem.makeDirectory(skillDirectory, { recursive: true });
          yield* fileSystem.writeFileString(path.join(skillDirectory, "SKILL.md"), contents);
        });

        yield* writeSkill(
          path.join(userHome, ".cursor", "skills"),
          "review",
          "---\ndescription: user review\n---\n",
        );
        yield* writeSkill(
          path.join(workspace, ".agents", "skills", "nested"),
          "review",
          "---\nname: Review changes\ndescription: project review\n---\n",
        );
        yield* writeSkill(
          path.join(workspace, ".cursor", "skills"),
          "internal",
          "---\nuser-invocable: false\n---\n",
        );
        yield* writeSkill(
          path.join(workspace, ".cursor", "skills"),
          "oversized",
          "x".repeat(1_000_001),
        );
        yield* fileSystem.makeDirectory(path.join(userHome, ".codex"), { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(userHome, ".codex", "skills"),
          "not a directory",
        );

        const skills = yield* discoverCursorSkills(workspace, { HOME: userHome });
        expect(skills).toEqual([
          {
            name: "internal",
            path: path.join(workspace, ".cursor", "skills", "internal", "SKILL.md"),
            scope: "project",
            enabled: true,
            userInvocable: false,
          },
          {
            name: "oversized",
            path: path.join(workspace, ".cursor", "skills", "oversized", "SKILL.md"),
            scope: "project",
            enabled: true,
          },
          {
            name: "review",
            displayName: "Review changes",
            description: "project review",
            path: path.join(workspace, ".agents", "skills", "nested", "review", "SKILL.md"),
            scope: "project",
            enabled: true,
          },
        ]);
        expect(
          (yield* probeCursorSkills(workspace, { HOME: userHome }).pipe(Effect.result))._tag,
        ).toBe("Failure");
      }),
    ));

  it("rewrites only discovered skill mentions into Cursor slash invocations", () => {
    expect(hasCursorSkillMention("use $Review_Pr:V2 here")).toBe(true);
    expect(hasCursorSkillMention("please $review this")).toBe(true);
    expect(
      rewriteCursorSkillMentions("use $review, keep $HOME and 5$review", new Set(["review"])),
    ).toBe("use $review, keep $HOME and 5$review");
    expect(rewriteCursorSkillMentions("please $review this", new Set(["review"]))).toBe(
      "please /review this",
    );
  });
});
